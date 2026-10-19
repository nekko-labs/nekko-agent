import { randomBytes } from 'crypto';
import type { AgentEvent, AskAnswer, PendingInput, QueuedPrompt, SendOptions, Session, ToolCall, ToolResult, TurnStats } from '@nekko-agent/shared';
import { sideUsageRecord } from './usage-records.js';
import { recordUsage } from './usage.js';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns, LIVENESS_INTERVAL_MS, LIVENESS_STRIKES } from './daemon-caps.js';

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
 *   (`turn:tool`: delegation targets; a training or goal run's tools only
 *   when the daemon does not own training), for
 *   hooks when the daemon does not run them itself (`turn:hook`; it does when
 *   it owns `turn:hooks`); a tool here that needs approval parks it in the daemon
 *   (`turn:approval`) and hears the answer through `turn:approved`;
 * - the events this side still reads reach it too (`turn:event`, deltas
 *   batched; `hostTurnEvents`), marked `relayOnly` (the UI already has them
 *   from the daemon): every one for a TS phone relay, messaging bridge or
 *   accounting, otherwise only how the turn ended;
 * - `turn:end` hands back how the reply ended; chat.ts runs the hooks and the
 *   linked spec. The daemon generates the chat's title itself (its usage
 *   comes back through `turn:usage`, its `session_meta` through
 *   `turn:notify`) and runs the next queued prompt: this host admits it
 *   (`turn:prepare`) and the daemon drives it as the next turn of the chain
 *   (`next` in the summary).
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
  /** The daemon started the chat's next queued prompt as this turn (from `turn:prepare`). */
  next?: string;
  /** The next queued prompt has to run in this process: its turn is this host's to start. */
  drain?: 'host';
  /** Set here, never by the daemon: the turn was lost (the daemon gone or no longer knowing it). */
  lost?: string;
}

export interface HostTurn {
  sessionId: string;
  /** The caller's listener; the events this host asked for arrive here marked `relayOnly`. */
  send: (event: AgentEvent) => void;
  /** Usage and reply accounting for the events of one batch; a `done` comes with the turn's stats and start time. */
  account: (events: AgentEvent[], extra: { stats?: TurnStats; startedAt?: number }) => void;
  /** A tool that still runs here. `patch` carries session fields it changed (a goal run's plan). */
  executeTool: (call: ToolCall) => Promise<{ result: ToolResult; patch?: Partial<Session> }>;
  hook: (phase: 'pre' | 'post', call: ToolCall, result?: ToolResult) => Promise<unknown>;
  /** What still follows a turn here once it has ended: the agent terminal, TurnEnd hooks, the linked spec. */
  afterEach: (summary: TurnSummary) => void;
  /**
   * `spawn:prepare`: check a `spawn_agent` call and make its child (attempt 0),
   * or admit the child's resume (a later attempt), for the daemon to drive.
   */
  spawn?: (call: ToolCall, attempt: number, childId?: string) => Promise<SpawnPrepared>;
}

/** What `spawn:prepare` hands the daemon: the child's turn, a failure to start it, or why it was refused. */
export type SpawnPrepared = { childId: string; spec: TurnSpec } | { childId: string; failure: string } | { error: string };

/** What the turns of one `sendChat` share: its listener, its Stop, its browser permission. */
export interface TurnChain {
  send: (event: AgentEvent) => void;
  allowBrowserControl: boolean;
  abort: AbortController;
}

interface Registered extends HostTurn {
  chain: TurnChain;
  end: (summary: TurnSummary) => void;
  ended: Promise<TurnSummary>;
  /** Anything arrived since the last liveness check. */
  heard: boolean;
}

const turns = new Map<string, Registered>();
/** Callbacks waiting for a turn the daemon admitted to be adopted here (`turn:adopt`). */
const awaited = new Map<string, Array<() => void>>();
/** How long a callback waits for a turn this host has not registered yet. */
const ADOPT_WAIT_MS = 5000;

/** The registered turn, waiting briefly for one the daemon admitted and is still handing over. */
async function registeredTurn(turnId: string): Promise<Registered | undefined> {
  const now = turns.get(turnId);
  if (now) return now;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ADOPT_WAIT_MS);
    function done() {
      clearTimeout(timer);
      const list = awaited.get(turnId)?.filter((f) => f !== done) ?? [];
      if (list.length) awaited.set(turnId, list);
      else awaited.delete(turnId);
      resolve();
    }
    awaited.set(turnId, [...(awaited.get(turnId) ?? []), done]);
  });
  return turns.get(turnId);
}
/** Approvals for tools run here, parked in the daemon, by tool call id. */
const approvals = new Map<string, (approved: boolean) => void>();

/**
 * A turn the daemon admitted itself: its id starts `turn_d` (admission.rs
 * `daemon_turn_id`), and its `turn:adopt` may still be on its way.
 */
function pendingAdoption(turnId: string): boolean {
  return turnId.startsWith('turn_d');
}

/** Register a turn the daemon is about to drive, so its callbacks find it. */
export function registerTurn(turnId: string, turn: HostTurn, chain: TurnChain): void {
  let end!: (summary: TurnSummary) => void;
  const ended = new Promise<TurnSummary>((resolve) => { end = resolve; });
  turns.set(turnId, { ...turn, chain, end, ended, heard: false });
  for (const wake of awaited.get(turnId) ?? []) wake();
}

/**
 * Register a turn the daemon drives on its own (a `spawn_agent` child), with
 * nobody here waiting on it: its callbacks find it, and when it ends (or the
 * daemon moves on to its next queued turn) its after-work runs and it is
 * dropped. `done` runs once the last of them has ended.
 */
export function adoptTurn(turnId: string, turn: HostTurn, chain: TurnChain, done?: () => void): void {
  registerTurn(turnId, turn, chain);
  void (async () => {
    let current = turnId;
    for (;;) {
      const registered = turns.get(current);
      if (!registered) break;
      const summary = await registered.ended;
      // A next turn the daemon admitted itself may still be on its way
      // (`turn:adopt`, chained): it joins this turn's chain, so this one stays
      // registered until it lands.
      if (summary.next && pendingAdoption(summary.next)) await registeredTurn(summary.next);
      turns.delete(current);
      if (!summary.early) registered.afterEach(summary);
      if (summary.next && turns.has(summary.next)) {
        current = summary.next;
        continue;
      }
      break;
    }
    done?.();
  })();
}

/**
 * Admits the chat's next queued prompt as a daemon turn (`turn:prepare`):
 * the spec for the daemon, or `ended` (the admission failed and said so), or
 * `inProcess` (this host must run it). Set by chat.ts.
 */
type Preparer = (chain: TurnChain, payload: { opts: SendOptions; queued: { index: number; item: QueuedPrompt } }) => Promise<{ spec: TurnSpec } | { ended: true } | { inProcess: true }>;
let preparer: Preparer | undefined;
export function setTurnPreparer(fn: Preparer): void {
  preparer = fn;
}

/** Where an event about a finished turn goes (the generated title's `session_meta`): this host's bus. Set by host.ts. */
let notify: ((event: AgentEvent) => void) | undefined;
export function setTurnNotifier(fn: (event: AgentEvent) => void): void {
  notify = fn;
}

/** The chain of the turn the daemon drives for this session, if any. */
export function chainOf(sessionId: string): TurnChain | undefined {
  for (const t of turns.values()) if (t.sessionId === sessionId) return t.chain;
  return undefined;
}

/** Whether the daemon drives this session's running turn. */
export function daemonTurnFor(sessionId: string): boolean {
  for (const t of turns.values()) if (t.sessionId === sessionId) return true;
  return false;
}

/**
 * What a daemon advertises in `daemon:info` `owned` when it writes a turn's
 * usage and reply lines and keeps its limits itself (from `facts.account`);
 * then `account` and `headers` here have nothing to do.
 */
export const TURN_ACCOUNT = 'turn:account';

/**
 * The event types this host still reads of a daemon-driven turn, for the
 * spec's `facts.hostEvents`; undefined for every one.
 *
 * The whole turn used to come back here (`turn:event`, deltas batched) for
 * the phone relay, messaging and accounting. Where the daemon runs all three
 * (`NEKKOD_OWNS` lists `remote` and `messaging`, and it accounts turns), what
 * is left here only follows how a turn ends (an agent watch's resume and a
 * sub-agent's start read the `error`). The UI and the local API server
 * (apps/desktop main/api-server.ts) take the events from the daemon itself.
 */
export function hostTurnEvents(daemonAccounts: boolean): string[] | undefined {
  const owns = (what: string) => (process.env.NEKKOD_OWNS ?? '').split(',').includes(what);
  return daemonAccounts && owns('remote') && owns('messaging') ? ['done', 'error'] : undefined;
}

/** Whether the engine daemon accounts for the turns it drives. */
export async function daemonAccountsTurns(call: Call): Promise<boolean> {
  return daemonOwns(call, TURN_ACCOUNT);
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

/** `turn:usage`: a side call the daemon made after a turn (the title), for the usage log. */
function sideUsage(payload: { provider?: { id?: string; kind?: string; auth?: string }; modelId?: string; sessionId?: string; usage?: Array<Record<string, number | undefined>> }): void {
  const provider = payload?.provider ?? {};
  for (const item of payload?.usage ?? []) recordUsage(sideUsageRecord(provider, payload.modelId, payload.sessionId, item, Date.now()));
}

/** The daemon calling back about a turn it drives (dispatch.ts `turn:*`). */
export async function turnCallback(channel: string, args: unknown[]): Promise<unknown> {
  const [turnId] = args as [string];
  if (channel === 'turn:approved') return approved(String(args[0]), args[1] === true);
  if (channel === 'turn:usage') return sideUsage(args[0] as never);
  if (channel === 'turn:notify') return notify?.({ ...(args[0] as AgentEvent), relayOnly: true } as unknown as AgentEvent);
  // A turn the daemon admitted may still be on its way here (`turn:adopt`).
  const turn = turns.get(String(turnId)) ?? (pendingAdoption(String(turnId)) ? await registeredTurn(String(turnId)) : undefined);
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
    case 'spawn:prepare': {
      const call = args[1] as ToolCall;
      if (!turn?.spawn || turn.chain.abort.signal.aborted) return { error: 'This run has already ended.' };
      turn.heard = true;
      return turn.spawn(call, Number(args[2] ?? 0), typeof args[3] === 'string' ? args[3] : undefined);
    }
    case 'turn:prepare': {
      // The previous turn of the chain is still registered: its turn:end comes after this.
      if (!turn || !preparer || turn.chain.abort.signal.aborted) return { ended: true };
      return preparer(turn.chain, args[1] as never);
    }
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
 * Run a turn on the daemon, and the queued prompts it goes on to, and
 * resolve with how the last one ended, or with null when the daemon would not
 * take the first (then the caller runs it in process). Each turn's own
 * after-work runs as it ends. Stop asks the daemon to stop whichever turn is
 * running; a daemon that goes quiet and no longer knows the turn (or cannot
 * be reached) ends it here as interrupted.
 */
export async function runTurnViaDaemon(
  call: Call,
  spec: TurnSpec,
  turn: HostTurn,
  chain: TurnChain,
  livenessIntervalMs = LIVENESS_INTERVAL_MS,
): Promise<TurnSummary | null> {
  let current = spec.turnId;
  registerTurn(current, turn, chain);
  const signal = chain.abort.signal;
  const stopped = (summary: TurnSummary) => turns.get(current)?.end(summary);
  const onAbort = () => void call('turn:abort', current).catch(() => stopped({ aborted: true, lost: 'Stopped' }));
  try {
    try {
      await call(CHAT_TURN, spec);
    } catch {
      return null;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    for (;;) {
      const registered = turns.get(current)!;
      const summary = await waitFor(call, current, registered, livenessIntervalMs);
      turns.delete(current);
      if (!summary.early) registered.afterEach(summary);
      if (summary.next && turns.has(summary.next) && !summary.lost) {
        current = summary.next;
        continue;
      }
      return summary;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    turns.delete(current);
  }
}

/** One turn's end, or its loss when the daemon goes quiet and no longer knows it. */
async function waitFor(call: Call, turnId: string, registered: Registered, livenessIntervalMs: number): Promise<TurnSummary> {
  let strikes = 0;
  let canProbe: boolean | undefined;
  for (;;) {
    const summary = await Promise.race([registered.ended, new Promise<null>((resolve) => setTimeout(() => resolve(null), livenessIntervalMs))]);
    if (summary) return summary;
    if (registered.heard) { registered.heard = false; continue; }
    canProbe ??= await daemonOwns(call, 'turn:alive');
    if (!canProbe) continue;
    try {
      const alive = await call<boolean>('turn:alive', turnId);
      strikes = 0;
      if (alive === false) {
        // turn:end may have just landed; it wins.
        return await Promise.race([registered.ended, new Promise<TurnSummary>((resolve) => setTimeout(() => resolve({ lost: 'The engine stopped driving this reply. The steps it finished are saved.' }), 50))]);
      }
    } catch {
      if (++strikes >= LIVENESS_STRIKES) return { lost: 'The engine could not be reached. The steps it finished are saved.' };
    }
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
