import { rememberConnectivityNotice } from './components/ConnectivityNotices.js';
/**
 * Every running turn, folded and kept alive for as long as the host is running
 * it, not for as long as somebody is looking at it.
 *
 * The chat pane used to be the only thing subscribed to the agent event stream,
 * which made watching a run a precondition for recording it. Workspaces render
 * only the active one, so switching tabs unmounted the pane, dropped its
 * listener, and threw away the partial reply, the tool list and the elapsed
 * clock. Coming back mounted a fresh pane with empty state, which is why the
 * run looked paused until the next event repainted it a second or two later.
 * Nothing was ever actually paused: the host streams to a channel nobody was
 * holding, so the tokens emitted while you were away were simply lost.
 *
 * So the subscription moves here: one listener for the whole app, started at
 * launch, that folds every session's events whether or not a pane exists. A
 * pane becomes a *view* of this, and mounting one replays what it missed.
 *
 * Deliberately outside React and outside the zustand store. Tokens arrive dozens
 * of times a second and every one of them would be a store write, re-rendering
 * every subscriber in the app; instead the state lives in a plain Map and
 * components subscribe to the sessions they care about on an animation-frame
 * cadence. `useLiveRun` below is the whole public surface for a component.
 *
 * This is also the only place streamed text is accumulated. A chat pane used to
 * keep a second copy, flushed into React state on its own 50 ms timer, which
 * meant two re-renders per frame for the same tokens; the pane now reads the
 * run from here like everything else does.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { AgentEvent, AgentReplay, ToolCall } from '@nekko-agent/shared';
import type { Activity } from './components/agent-console/transcript.js';
import { accumulateDecodeMs, describeLiveActivity, emptyLiveActivity, reduceLiveActivity, type LiveActivity } from '@nekko-agent/shared';

export type LiveBlock = { kind: 'text'; text: string } | { kind: 'activity'; items: Activity[] };

/** One session's in-flight turn, as much of it as a pane needs to redraw. */
export interface LiveRun {
  sessionId: string;
  /** Progress text and working steps in the order they arrive. */
  blocks: LiveBlock[];
  /** The assistant text streamed so far this turn. */
  text: string;
  /** Reasoning streamed so far this turn. */
  reasoning: string;
  /** Tool calls made this turn, in order. */
  tools: ToolCall[];
  /** When the turn started, for the elapsed clock. */
  startedAt: number;
  /** Output tokens and decode time, summed across the turn's steps. */
  outputTokens: number;
  decodeMs: number;
  inputTokens: number;
  /** Current call only: excludes prompt latency, tool waits and retry backoff. */
  generation?: { chars: number; startedAt: number; lastAt: number };
  /** Milliseconds of reasoning, once a thought has been closed out by text. */
  reasoningMs: number;
  /** Set while reasoning is streaming, so the pane can show the thinking dot. */
  reasoningStartedAt: number;
  /** The folded step rail, shared with the Agent board's cards. */
  activity: LiveActivity;
  /**
   * Where the current model call started: the blocks, text and reasoning as
   * they stood at the last step boundary. A `retry` event rolls back to it,
   * since the failed call's output is regenerated rather than kept.
   */
  stepMark: { blocks: LiveBlock[]; text: string; reasoning: string };
  /** The retry the loop is waiting out, until the next event arrives. */
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string; at: number };
}

import { foldSubagentActivity, startSubagentActivity, stopSubagentActivity, resetSubagentActivity, resetSubagentActivityFor } from './subagentActivity.js';

const runs = new Map<string, LiveRun>();
/**
 * Runs that just ended, kept until the pane showing them has the persisted
 * transcript in hand (see `takeFinishedRun`), so the end of a reply never
 * blinks out and back in. Not visible to anything that asks what is running.
 */
const finished = new Map<string, LiveRun>();
const FINISHED_MAX = 8;

/**
 * Cap on a live buffer's length. The engine cuts a looping model off (see
 * runaway.ts), so this is the second line of defence: the renderer never holds
 * an unbounded string. Past the cap the head is dropped back to three quarters
 * of it, at a paragraph break where there is one, so the retained tail (the
 * part still being written) stays put for thousands of tokens instead of
 * shifting under every one, which keeps its finished blocks memoized.
 */
export const LIVE_STREAM_MAX = 40_000;

export function clampLive(s: string): string {
  if (s.length <= LIVE_STREAM_MAX) return s;
  let cut = s.length - Math.floor(LIVE_STREAM_MAX * 0.75);
  const para = s.indexOf('\n\n', cut);
  if (para >= 0 && para - cut < 2_000) cut = para + 2;
  return `…\n${s.slice(cut)}`;
}
/** Per-session subscriber sets, so a pane only wakes for its own chat. */
const listeners = new Map<string, Set<() => void>>();
/** Subscribers that want to know about *any* change (the sub-agent rail). */
const globalListeners = new Set<() => void>();

/**
 * Snapshots handed to React. `useSyncExternalStore` compares by identity and
 * re-renders whenever the reference changes, so a run is replaced wholesale on
 * each repaint and the map below caches the current object per session.
 */
let version = 0;

function emptyRun(sessionId: string, now: number): LiveRun {
  return {
    sessionId,
    blocks: [],
    text: '',
    reasoning: '',
    tools: [],
    startedAt: now,
    outputTokens: 0,
    decodeMs: 0,
    inputTokens: 0,
    reasoningMs: 0,
    reasoningStartedAt: 0,
    activity: emptyLiveActivity(now),
    stepMark: { blocks: [], text: '', reasoning: '' },
  };
}

/**
 * Sessions whose next repaint is still pending.
 *
 * Coalescing to one frame is what keeps a fast local model from re-rendering
 * the transcript per token: the run is mutated immediately (so a pane mounting
 * mid-frame reads current state) and subscribers are told at most 60 times a
 * second.
 */
const dirty = new Set<string>();
let frame: number | null = null;

function markDirty(sessionId: string): void {
  dirty.add(sessionId);
  if (frame != null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const wake = [...dirty];
    dirty.clear();
    version++;
    for (const id of wake) for (const fn of listeners.get(id) ?? []) fn();
    for (const fn of globalListeners) fn();
  });
}

/** Events that mean a turn is actually producing something, so may open a run. */
const STARTS_RUN = new Set<AgentEvent['type']>([
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'tool_approval_required',
  'question',
  'image_status',
  'usage',
  // A first call that fails before its first token is still a turn in flight,
  // and the rail should say it is being retried rather than nothing at all.
  'retry',
]);

/**
 * Fold one event into its session's run.
 *
 * Exported for the tests: the interesting behaviour is that a turn accumulates
 * across events and is dropped on `done`/`error`, and that is provable without
 * a DOM or an IPC bridge.
 */
export function applyEvent(event: AgentEvent, now = Date.now()): void {
  if (event.type === 'session_meta' && event.connectivityNotice) rememberConnectivityNotice(event.sessionId, event.connectivityNotice);
  const id = event.sessionId;
  if (!runs.has(id) && STARTS_RUN.has(event.type)) startSubagentActivity(id);
  foldSubagentActivity(event, now);

  // The rail folds first, so a card repainted this frame is never a step behind.
  const folded = reduceLiveActivity(runs.get(id)?.activity, event, now);

  if (event.type === 'done' || event.type === 'error') {
    const ended = runs.get(id);
    runs.delete(id);
    if (ended) {
      finished.delete(id);
      finished.set(id, ended);
      while (finished.size > FINISHED_MAX) finished.delete(finished.keys().next().value!);
    }
    markDirty(id);
    return;
  }

  // Bookkeeping events never start a run. `session_meta` in particular lands
  // *after* `done` (the auto-title is generated once the first turn is over),
  // and folding it in used to resurrect an empty run that nothing would ever
  // end: the chat sat on "Starting" with its clock climbing for hours.
  if (!runs.has(id) && !STARTS_RUN.has(event.type)) return;

  const prev = runs.get(id) ?? emptyRun(id, now);
  if (!runs.has(id)) finished.delete(id);
  const next: LiveRun = { ...prev, activity: folded ?? prev.activity };
  if (event.type === 'retry') {
    // Roll the live reply back to the last step boundary: what the failed
    // call streamed is being regenerated, and showing it twice would read as
    // the model repeating itself.
    next.blocks = prev.stepMark.blocks;
    next.text = prev.stepMark.text;
    next.reasoning = prev.stepMark.reasoning;
    next.reasoningStartedAt = 0;
    next.generation = undefined;
    next.retrying = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, reason: event.reason, at: now };
    runs.set(id, next);
    markDirty(id);
    return;
  }
  if (prev.retrying && (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call')) next.retrying = undefined;
  if ((event.type === 'text' || event.type === 'reasoning') && event.delta) {
    const generation = prev.generation;
    next.generation = { chars: (generation?.chars ?? 0) + event.delta.length, startedAt: generation?.startedAt ?? now, lastAt: now };
  }
  const last = prev.blocks[prev.blocks.length - 1];
  if (event.type === 'text') {
    const block: LiveBlock = { kind: 'text', text: clampLive((last?.kind === 'text' ? last.text : '') + event.delta) };
    next.blocks = last?.kind === 'text' ? [...prev.blocks.slice(0, -1), block] : [...prev.blocks, block];
  } else if (event.type === 'reasoning' || event.type === 'tool_call') {
    const items = last?.kind === 'activity' ? last.items : [];
    const tail = items[items.length - 1];
    const item: Activity = event.type === 'tool_call'
      ? { kind: 'tool', call: event.call, startedAt: now }
      : { kind: 'reasoning', text: clampLive((tail?.kind === 'reasoning' ? tail.text : '') + event.delta), duration: null };
    const merged = event.type === 'reasoning' && tail?.kind === 'reasoning' ? [...items.slice(0, -1), item] : [...items, item];
    const block: LiveBlock = { kind: 'activity', items: merged };
    next.blocks = last?.kind === 'activity' ? [...prev.blocks.slice(0, -1), block] : [...prev.blocks, block];
  }

  switch (event.type) {
    case 'text':
      // Text closes out whatever was being thought, which is what makes the
      // "Thought for Ns" duration a measurement rather than a guess.
      if (next.reasoningStartedAt) {
        next.reasoningMs += now - next.reasoningStartedAt;
        next.reasoningStartedAt = 0;
      }
      next.text = clampLive(prev.text + event.delta);
      break;
    case 'reasoning':
      if (!next.reasoningStartedAt) next.reasoningStartedAt = now;
      next.reasoning = clampLive(prev.reasoning + event.delta);
      break;
    case 'tool_call':
      next.generation = undefined;
      if (next.reasoningStartedAt) {
        next.reasoningMs += now - next.reasoningStartedAt;
        next.reasoningStartedAt = 0;
      }
      next.tools = [...prev.tools, event.call];
      break;
    case 'usage':
      next.generation = undefined;
      next.outputTokens = prev.outputTokens + event.outputTokens;
      next.inputTokens = prev.inputTokens + event.inputTokens;
      next.decodeMs = accumulateDecodeMs(prev.decodeMs, event.outputTokens, event.outputMs);
      break;
    case 'tool_result':
      next.blocks = next.blocks.map((b) => b.kind !== 'activity' ? b : {
        ...b,
        items: b.items.map((it) => it.kind === 'tool' && it.call.id === event.result.toolCallId && it.endedAt === undefined ? { ...it, endedAt: now, ...(event.result.isError ? { failed: true } : {}) } : it),
      });
      // A step boundary: the next model call starts from here.
      next.stepMark = { blocks: next.blocks, text: next.text, reasoning: next.reasoning };
      break;
    default:
      // Approvals and questions are pending-input state, owned by the host and
      // read back from it; recording them here would duplicate that.
      break;
  }

  runs.set(id, next);
  markDirty(id);
}

/**
 * A running turn's events so far, sent when this window starts showing a chat
 * mid-turn (agentSubscription.ts): until then it had only the turn's summary
 * events, so the run is rebuilt from the replay, at the times the events
 * happened, replacing what was folded from the summaries. The engine sends it
 * in order with the live events (only while the turn runs), so it is never
 * older than a `done` already folded here.
 */
export function applyReplay(replay: AgentReplay): void {
  const id = replay.sessionId;
  const events = replay.events ?? [];
  if (!events.length) return;
  const keepStart = runs.get(id)?.startedAt;
  runs.delete(id);
  resetSubagentActivityFor(id);
  events.forEach((e, i) => applyEvent({ ...e, sessionId: id } as AgentEvent, replay.at?.[i] ?? Date.now()));
  const run = runs.get(id);
  if (run && keepStart !== undefined && keepStart < run.startedAt) runs.set(id, { ...run, startedAt: keepStart });
  markDirty(id);
}

/** Start folding events for the whole app. Called once, at launch. */
export function startLiveRuns(): () => void {
  const offEvents = window.nekko.onAgentEvent((e: AgentEvent) => applyEvent(e));
  const offReplay = window.nekko.onAgentReplay?.((r) => applyReplay(r));
  return () => { offEvents(); offReplay?.(); };
}

/** The run in flight for a session, or undefined when it is idle. */
export function getLiveRun(sessionId: string): LiveRun | undefined {
  return runs.get(sessionId);
}

/**
 * The run that just ended for a session, handed over once. The pane that was
 * showing it keeps it on screen until the persisted reply replaces it.
 */
export function takeFinishedRun(sessionId: string): LiveRun | undefined {
  const run = finished.get(sessionId);
  finished.delete(sessionId);
  return run;
}

/** Every session with a turn in flight. */
export function runningSessionIds(): string[] {
  return [...runs.keys()];
}

/**
 * Drop a session's run.
 *
 * The pane calls this when it has folded the finished turn into the persisted
 * transcript, so the live copy and the stored copy are never both on screen.
 */
export function clearLiveRun(sessionId: string): void {
  if (!runs.has(sessionId)) return;
  stopSubagentActivity(sessionId);
  runs.delete(sessionId);
  markDirty(sessionId);
}

function subscribeTo(sessionId: string, fn: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Subscribe a component to one session's live run.
 *
 * Returns `undefined` while that chat is idle, which is the signal to render
 * the stored transcript instead.
 */
export function useLiveRun(sessionId: string, paused = false): LiveRun | undefined {
  // A hidden pane stops listening; it reads the current run again the moment
  // it is shown, since the snapshot is always the live map's entry.
  const subscribe = useCallback(
    (fn: () => void) => (paused ? () => {} : subscribeTo(sessionId, fn)),
    [sessionId, paused],
  );
  return useSyncExternalStore(subscribe, () => runs.get(sessionId));
}

/**
 * Subscribe to the set of running sessions, as a version counter.
 *
 * The sub-agent rail needs to repaint when any of several children moves, and
 * the children change as they are spawned; watching the counter is simpler than
 * juggling a subscription per child id.
 */
export function useLiveRunsVersion(): number {
  return useSyncExternalStore((fn) => {
    globalListeners.add(fn);
    return () => globalListeners.delete(fn);
  }, () => version, () => 0);
}

/** Stable membership snapshot: token updates do not change quota polling cadence. */
export function runningSessionsSnapshot(): string {
  return JSON.stringify([...runs.keys()].sort());
}

export function useRunningSessionsSnapshot(): string {
  return useSyncExternalStore((fn) => {
    globalListeners.add(fn);
    return () => globalListeners.delete(fn);
  }, runningSessionsSnapshot, () => '[]');
}

/** What a session is doing right now, in a few words. Empty when idle. */
export function describeRun(sessionId: string): string {
  return describeLiveActivity(runs.get(sessionId)?.activity);
}

/** Reset everything. Tests only. */
export function __resetLiveRuns(): void {
  resetSubagentActivity();
  runs.clear();
  finished.clear();
  listeners.clear();
  globalListeners.clear();
  dirty.clear();
  if (frame != null) cancelAnimationFrame(frame);
  frame = null;
}
