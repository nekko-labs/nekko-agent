import { randomBytes } from 'crypto';
import type { AgentEvent, AskAnswer, PendingInput, QueuedPrompt, SendOptions, Session, ToolCall, ToolResult, TurnStats } from '@nekko-agent/shared';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns, LIVENESS_INTERVAL_MS, LIVENESS_STRIKES } from './daemon-loop.js';

/**
 * A whole chat turn driven by the engine daemon (`chat:turn`, crates/nekkod
 * src/turns.rs), PF14 steps 2 and 3.
 *
 * The daemon composes the turn (tool list, context from disk, system prompt),
 * writes the user's message and every checkpoint to the chat file itself
 * (`nekko-store`), runs the loop and the built-in tools, and owns the input
 * the turn waits on: tool approvals and `ask_user` questions are parked there,
 * shown to the UI from there, and answered there (`tool:approve`,
 * `chat:answer`, `chat:pending`), so an approval never waits on this process.
 *
 * This side keeps what still needs TS services, and is asked for it:
 * - before the turn, chat.ts admits it (provider, session, sandbox, worktree
 *   setup, offline and endpoint checks), syncs MCP, asks the decision runner,
 *   fetches connector and index snippets and resolves the provider (a fresh
 *   subscription token), and puts all of that in the `chat:turn` spec;
 * - during it, the daemon calls back for the tools that still live here
 *   (`turn:tool`: MCP, sub-agents, the browser, processes, fetch, watches,
 *   training reports, `decide`), for hooks (`turn:hook`) and with Anthropic
 *   rate-limit headers (`turn:headers`); a tool here that needs approval parks it in the daemon
 *   (`turn:approval`) and hears the answer through `turn:approved`;
 * - every event reaches this side too (`turn:event`, deltas batched), marked
 *   `relayOnly` (the UI already has it from the daemon), for the phone relay,
 *   the caller's own listeners, and usage and reply accounting;
 * - `turn:end` hands back how the reply ended, and chat.ts runs what follows.
 */

type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>;
type Severity = 'low' | 'medium' | 'high';

/** What a daemon advertises in `daemon:info` `owned` when it can drive whole chat turns. */
export const CHAT_TURN = 'chat:turn';

export interface TurnSummary {
  /** How the reply ended, when it finished (`done.stop`). */
  stop?: 'complete' | 'loop' | 'runaway';
  /** The turn ended before its reply started (stopped first, a queued prompt that changed, no provider): nothing follows it. */
  early?: boolean;
  /** The user stopped it. */
  aborted?: boolean;
  /** Set here, never by the daemon: the turn was lost (the daemon gone or no longer knowing it). */
  lost?: string;
}

export interface HostTurn {
  sessionId: string;
  /** The caller's listener; every event arrives here marked `relayOnly`. */
  send: (event: AgentEvent) => void;
  /** Usage and reply accounting for the events of one batch; a `done` comes with the turn's stats and start time. */
  account: (events: AgentEvent[], extra: { stats?: TurnStats; startedAt?: number }) => void;
  /** A tool that still runs here. `patch` carries session fields it changed (a goal run's plan). */
  executeTool: (call: ToolCall) => Promise<{ result: ToolResult; patch?: Partial<Session> }>;
  hook: (phase: 'pre' | 'post', call: ToolCall, result?: ToolResult) => Promise<unknown>;
  headers: (pairs: Array<[string, string]>) => void;
}

interface Registered extends HostTurn {
  end: (summary: TurnSummary) => void;
  /** Anything arrived since the last liveness check. */
  heard: boolean;
}

const turns = new Map<string, Registered>();
/** Approvals for tools run here, parked in the daemon, by tool call id. */
const approvals = new Map<string, (approved: boolean) => void>();

/** Whether the daemon drives this session's running turn. */
export function daemonTurnFor(sessionId: string): boolean {
  for (const t of turns.values()) if (t.sessionId === sessionId) return true;
  return false;
}

/** Whether the engine daemon can drive whole chat turns. */
export async function daemonRunsTurns(call: Call): Promise<boolean> {
  return daemonOwns(call, CHAT_TURN);
}

/**
 * The approval prompt for a tool this host runs in a daemon-driven turn. The
 * question is parked in the daemon with the rest of the turn's input; the
 * answer comes back through `turn:approved`. A daemon that cannot be reached
 * is a no.
 */
export function approvalViaDaemon(turnId: string): (call: ToolCall, reason: string, severity: Severity) => Promise<boolean> {
  return (call, reason, severity) => new Promise<boolean>((resolve) => {
    const call_ = daemonCall();
    if (!call_) return resolve(false);
    approvals.set(call.id, resolve);
    call_('turn:approval', turnId, call, reason, severity).catch(() => {
      approvals.delete(call.id);
      resolve(false);
    });
  });
}

/** `turn:approved`: the daemon's answer to an approval this host parked there. */
function approved(callId: string, ok: boolean): void {
  const resolve = approvals.get(callId);
  approvals.delete(callId);
  resolve?.(ok === true);
}

/** The daemon calling back about a turn it drives (dispatch.ts `turn:*`). */
export async function turnCallback(channel: string, args: unknown[]): Promise<unknown> {
  const [turnId] = args as [string];
  if (channel === 'turn:approved') return approved(String(args[0]), args[1] === true);
  const turn = turns.get(String(turnId));
  switch (channel) {
    case 'turn:event': {
      if (!turn) return; // a turn a restarted host never started: the daemon saved it already
      turn.heard = true;
      const payload = (args[1] ?? {}) as { events?: AgentEvent[]; stats?: TurnStats; startedAt?: number };
      const events = payload.events ?? [];
      turn.account(events, { stats: payload.stats, startedAt: payload.startedAt });
      for (const event of events) turn.send({ ...event, relayOnly: true } as unknown as AgentEvent);
      return;
    }
    case 'turn:end':
      turn?.end((args[1] ?? {}) as TurnSummary);
      return;
    case 'turn:tool': {
      const call = args[1] as ToolCall;
      if (!turn) return { result: { toolCallId: call?.id ?? '', output: 'This run has already ended.', isError: true } };
      turn.heard = true;
      return turn.executeTool(call);
    }
    case 'turn:hook':
      if (!turn) return args[1] === 'post' ? args[3] : { notes: [] };
      return turn.hook(args[1] as 'pre' | 'post', args[2] as ToolCall, args[3] as ToolResult | undefined);
    case 'turn:headers':
      turn?.headers((args[1] ?? []) as Array<[string, string]>);
      return;
    default:
      throw new Error(`unknown turn callback ${channel}`);
  }
}

export interface TurnSpec {
  /** From `newTurnId()`, made first so the turn's approval prompt can name it. */
  turnId: string;
  opts: SendOptions;
  queued?: { index: number; item: QueuedPrompt };
  [key: string]: unknown;
}

/**
 * Run one turn on the daemon and resolve with how it ended, or with null when
 * the daemon would not take it (then the caller runs it in process). Stop
 * asks the daemon to stop; a daemon that goes quiet and no longer knows the
 * turn (or cannot be reached) ends it here as interrupted.
 */
export async function runTurnViaDaemon(
  call: Call,
  spec: TurnSpec,
  turn: HostTurn,
  signal: AbortSignal,
  livenessIntervalMs = LIVENESS_INTERVAL_MS,
): Promise<TurnSummary | null> {
  const turnId = spec.turnId;
  let finish!: (summary: TurnSummary) => void;
  const ended = new Promise<TurnSummary>((resolve) => { finish = resolve; });
  const registered: Registered = { ...turn, heard: false, end: (summary) => finish(summary) };
  turns.set(turnId, registered);
  const onAbort = () => void call('turn:abort', turnId).catch(() => finish({ aborted: true, lost: 'Stopped' }));
  try {
    try {
      await call(CHAT_TURN, spec);
    } catch {
      return null;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let strikes = 0;
    let canProbe: boolean | undefined;
    for (;;) {
      const summary = await Promise.race([ended, new Promise<null>((resolve) => setTimeout(() => resolve(null), livenessIntervalMs))]);
      if (summary) return summary;
      if (registered.heard) { registered.heard = false; continue; }
      canProbe ??= await daemonOwns(call, 'turn:alive');
      if (!canProbe) continue;
      try {
        const alive = await call<boolean>('turn:alive', turnId);
        strikes = 0;
        if (alive === false) {
          // turn:end may have just landed; it wins.
          return await Promise.race([ended, new Promise<TurnSummary>((resolve) => setTimeout(() => resolve({ lost: 'The engine stopped driving this reply. The steps it finished are saved.' }), 50))]);
        }
      } catch {
        if (++strikes >= LIVENESS_STRIKES) return { lost: 'The engine could not be reached. The steps it finished are saved.' };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    turns.delete(turnId);
  }
}

/** Steer the daemon's running turn; false when it has none for the session. */
export async function steerDaemonTurn(sessionId: string, message: unknown): Promise<boolean> {
  const call = daemonCall();
  if (!call || !daemonTurnFor(sessionId)) return false;
  return call<boolean>('turn:steer', sessionId, message).catch(() => false);
}

/** Resolve an approval the daemon holds; false when it holds none by that id. */
export async function approveInDaemon(sessionId: string, callId: string, ok: boolean): Promise<boolean> {
  const call = daemonCall();
  if (!call || !(await daemonRunsTurns(call))) return false;
  return call<boolean>('turn:approve', sessionId, callId, ok).catch(() => false);
}

/** Answer a question the daemon holds; false when it holds none by that id. */
export async function answerInDaemon(sessionId: string, callId: string, answers: AskAnswer[]): Promise<boolean> {
  const call = daemonCall();
  if (!call || !(await daemonRunsTurns(call))) return false;
  return call<boolean>('turn:answer', sessionId, callId, answers).catch(() => false);
}

/** What the daemon's turns are waiting on a person for, keyed by session. */
export async function daemonPendingInput(): Promise<Record<string, PendingInput>> {
  const call = daemonCall();
  if (!call || !(await daemonRunsTurns(call))) return {};
  return call<Record<string, PendingInput>>('turn:pending').catch(() => ({}));
}

/** Merge two pending maps; `over` wins field by field. */
export function mergePending(base: Record<string, PendingInput>, over: Record<string, PendingInput>): Record<string, PendingInput> {
  const out: Record<string, PendingInput> = { ...base };
  for (const [id, p] of Object.entries(over ?? {})) {
    const merged: PendingInput = { ...(out[id] ?? { sessionId: id }), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as PendingInput;
    out[id] = merged;
  }
  return out;
}

export function newTurnId(): string {
  return `turn_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}
