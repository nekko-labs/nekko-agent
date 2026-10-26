import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { parsePrUrl, truncateWords, type AgentWatchView, type ToolCall, type ToolResult } from '@nekko-agent/shared';
import { compactSentence } from './subagentActivity.js';

/**
 * Agent watches as the transcript shows them. The `agent_watch` tool call
 * says what was armed; the host's `session:watches` list says how it is doing
 * now (armed, due, triggered, cancelled, failed). Rows join the two by the id
 * the tool result reports.
 */

/** The chat whose watches the transcript rows read. */
export const WatchSessionContext = createContext<string | undefined>(undefined);

export interface WatchCall {
  action: 'create' | 'list' | 'cancel' | 'unknown';
  kind?: 'timer' | 'pr';
  url?: string;
  /** Timer delay or PR maximum wait, in seconds. */
  seconds?: number;
  prompt: string;
  /** The id this call armed or cancelled, once its result is in. */
  id?: string;
}

export function parseWatchCall(call: ToolCall, result?: ToolResult): WatchCall {
  const input = call.input ?? {};
  const action = input.action === 'create' || input.action === 'list' || input.action === 'cancel' ? input.action : 'unknown';
  const kind = input.kind === 'timer' || input.kind === 'pr' ? input.kind : undefined;
  const raw = Number(kind === 'timer' ? input.delay_seconds ?? 300 : input.timeout_seconds ?? 3600);
  const fromResult = result && !result.isError ? /Watch (?:already )?armed: ([\w-]+)/.exec(result.output)?.[1] : undefined;
  return {
    action,
    kind,
    url: typeof input.url === 'string' ? input.url : undefined,
    seconds: kind && Number.isFinite(raw) ? raw : undefined,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    id: fromResult ?? (action === 'cancel' && typeof input.id === 'string' ? input.id : undefined),
  };
}

/** "PR #555" with the repository kept for the tooltip. */
export function prLabel(url: string | undefined): { short: string; full: string } | null {
  const pr = url ? parsePrUrl(url) : null;
  return pr ? { short: `PR #${pr.number}`, full: `${pr.owner}/${pr.repo}#${pr.number}` } : null;
}

export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  return `${Math.round(h / 24)} days`;
}

/** What the watch is looking at and what makes it fire, in one line. */
export function watchHeadline(w: WatchCall): string {
  if (w.action === 'list') return 'Checked this chat’s watches';
  if (w.action === 'cancel') return `Cancelled watch ${w.id ? w.id.slice(0, 8) : ''}`.trim();
  const limit = w.seconds ? fmtSpan(w.seconds * 1000) : '';
  if (w.kind === 'pr') {
    const pr = prLabel(w.url);
    return `Watching ${pr?.short ?? 'a pull request'} · wakes on any PR change${limit ? ` or after ${limit}` : ''}`;
  }
  if (w.kind === 'timer') return `Timer watch · wakes after ${limit || 'its delay'}`;
  return 'Agent watch';
}

/** What the agent will do when it wakes, in a few words. */
export function thenSummary(prompt: string, words = 60): string {
  const sentence = compactSentence(prompt, 400);
  return sentence ? truncateWords(sentence, words) : '';
}

export type WatchTone = 'normal' | 'warn' | 'danger' | 'quiet';
export interface WatchClock { text: string; tone: WatchTone; title: string; ticking: boolean }

/**
 * The timer a watch row wears. A watch that is still armed after its deadline,
 * or due but not yet delivered, is taking longer than it should and says so.
 */
export function watchClock(w: WatchCall, view: AgentWatchView | undefined, now: number): WatchClock | null {
  if (!view) return null;
  const armedAt = w.seconds ? view.deadlineAt - w.seconds * 1000 : undefined;
  const at = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const since = armedAt ? ` Armed ${fmtSpan(now - armedAt)} ago.` : '';
  if (view.status === 'done') return { text: 'triggered', tone: 'quiet', title: 'This watch fired and woke the chat.', ticking: false };
  if (view.status === 'cancelled') return { text: 'cancelled', tone: 'quiet', title: view.lastError ? `Cancelled: ${view.lastError}` : 'This watch was cancelled.', ticking: false };
  if (view.status === 'error') return { text: 'failed to wake', tone: 'danger', title: `The wake-up could not be delivered${view.lastError ? `: ${view.lastError}` : '.'}`, ticking: false };
  const late = now - view.deadlineAt;
  if (view.pending) {
    return { text: 'due · waiting for the chat', tone: late > 120_000 || view.failures ? 'warn' : 'normal', title: `Triggered; waiting for the chat to be free before continuing.${view.lastError ? ` Last error: ${view.lastError}` : ''}`, ticking: true };
  }
  // The scheduler polls every 15 s, so a minute's grace before calling it late.
  if (late > 60_000) {
    return { text: `overdue ${fmtSpan(late)}`, tone: 'warn', title: `Expected to wake by ${at(view.deadlineAt)}. Is the app or engine running?${since}${view.lastError ? ` Last error: ${view.lastError}` : ''}`, ticking: true };
  }
  const left = Math.max(0, view.deadlineAt - now);
  const retrying = view.failures > 0 ? ' · retrying' : '';
  return {
    text: `${w.kind === 'pr' ? '≤ ' : ''}${fmtSpan(left)} left${retrying}`,
    tone: view.failures > 0 ? 'warn' : 'normal',
    title: `${w.kind === 'pr' ? `Wakes on a PR change, or at ${at(view.deadlineAt)} at the latest.` : `Wakes at ${at(view.deadlineAt)}.`}${since}${view.lastError ? ` Last polling error: ${view.lastError}` : ''}`,
    ticking: true,
  };
}

/** A `[Agent watch <id>]` wake-up the host sent as a user turn. */
export interface WatchWake { id: string; trigger: string; detail: string; prompt: string; url?: string }

const WAKE = /^\[Agent watch ([^\]\n]+)\]\n/;
export function isWatchWake(content: string): boolean { return WAKE.test(content); }

export function parseWatchWake(content: string): WatchWake | null {
  const head = WAKE.exec(content);
  if (!head) return null;
  const body = content.slice(head[0].length);
  const split = body.indexOf('\n\nContinuation requested when armed:\n');
  const reason = (split >= 0 ? body.slice(0, split) : body).trim();
  const rest = split >= 0 ? body.slice(split + '\n\nContinuation requested when armed:\n'.length) : '';
  const prompt = rest.replace(/\n\nThis wake-up grants no new permissions\.[\s\S]*$/, '').trim();
  const changed = /^PR state changed for (\S+?)\.? Fetch the latest details before acting\. Snapshot: (.*)$/s.exec(reason);
  if (changed) {
    const url = changed[1];
    const pr = prLabel(url);
    let detail = '';
    try {
      const snap = JSON.parse(changed[2]) as Record<string, unknown>;
      const parts = [
        typeof snap.state === 'string' ? snap.state : '',
        typeof snap.checks === 'string' && snap.checks !== 'none' ? `checks ${snap.checks}` : '',
        snap.isDraft === true ? 'draft' : '',
        typeof snap.reviewDecision === 'string' ? snap.reviewDecision.toLowerCase().replace(/_/g, ' ') : '',
      ].filter(Boolean);
      detail = parts.join(', ');
    } catch { /* an unparseable snapshot still reads as a change */ }
    return { id: head[1], trigger: `${pr?.short ?? 'PR'} changed`, detail, prompt, url };
  }
  if (reason.startsWith('Watch deadline reached')) {
    const error = /Last polling error: (.*)$/s.exec(reason)?.[1];
    return { id: head[1], trigger: 'Deadline reached', detail: error ? `last polling error: ${compactSentence(error, 80)}` : '', prompt };
  }
  return { id: head[1], trigger: 'Woke up', detail: compactSentence(reason, 100), prompt };
}

// One poller per chat, shared by every row that reads it.
interface Entry { views: AgentWatchView[] | null; listeners: Set<() => void>; stop?: () => void }
const entries = new Map<string, Entry>();
const POLL_MS = 15_000;

function entryFor(sessionId: string): Entry {
  let e = entries.get(sessionId);
  if (!e) { e = { views: null, listeners: new Set() }; entries.set(sessionId, e); }
  return e;
}

export function refreshAgentWatches(sessionId: string): void {
  const api = typeof window !== 'undefined' ? window.nekko : undefined;
  if (!api?.listAgentWatches) return;
  const e = entryFor(sessionId);
  void Promise.resolve(api.listAgentWatches(sessionId)).then((views) => {
    if (entries.get(sessionId) !== e) return;
    const next = Array.isArray(views) ? views : [];
    if (JSON.stringify(next) === JSON.stringify(e.views)) return;
    e.views = next;
    e.listeners.forEach((fn) => fn());
  }).catch(() => {});
}

function start(sessionId: string, e: Entry): void {
  const api = typeof window !== 'undefined' ? window.nekko : undefined;
  if (!api) return;
  refreshAgentWatches(sessionId);
  const timer = setInterval(() => refreshAgentWatches(sessionId), POLL_MS);
  // A watch is armed, cancelled or delivered at a tool result or a turn's end.
  const off = api.onAgentEvent?.((event) => {
    if (event.sessionId === sessionId && ['tool_result', 'done', 'error', 'message'].includes(event.type)) refreshAgentWatches(sessionId);
  });
  e.stop = () => { clearInterval(timer); off?.(); };
}

function subscribe(sessionId: string, fn: () => void): () => void {
  const e = entryFor(sessionId);
  e.listeners.add(fn);
  if (e.listeners.size === 1) start(sessionId, e);
  return () => {
    e.listeners.delete(fn);
    if (!e.listeners.size) { e.stop?.(); entries.delete(sessionId); }
  };
}

const noop = () => () => {};
/** The current state of one watch, kept fresh while a row shows it. */
export function useAgentWatch(id: string | undefined): AgentWatchView | undefined {
  const sessionId = useContext(WatchSessionContext);
  const snapshot = () => (sessionId ? entries.get(sessionId)?.views ?? null : null);
  const views = useSyncExternalStore(sessionId ? (fn) => subscribe(sessionId, fn) : noop, snapshot, snapshot);
  return id ? views?.find((v) => v.id === id) : undefined;
}

/** Test seam. */
export function __setAgentWatches(sessionId: string, views: AgentWatchView[] | null): void {
  const e = entryFor(sessionId);
  e.views = views;
  e.listeners.forEach((fn) => fn());
}

/** Live watches for user-started continuation controls, sharing the transcript poller. */
export function useAgentWatches(sessionId: string): AgentWatchView[] {
  const listen = useCallback((fn: () => void) => subscribe(sessionId, fn), [sessionId]);
  const snapshot = useCallback(() => entries.get(sessionId)?.views ?? null, [sessionId]);
  return useSyncExternalStore(listen, snapshot, snapshot) ?? [];
}
