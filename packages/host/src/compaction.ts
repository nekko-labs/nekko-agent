import { randomUUID } from 'node:crypto';
import type { AgentEvent, CompactionProgress, ProviderConfig, Session } from '@nekko-agent/shared';
import { knownContextWindow } from './context-window.js';
import { createHostProvider as createProvider } from './prompt-caching.js';
import { getSettings } from './store.js';
import { forkSession, getSession, saveSession } from './sessions.js';
import { isChatRunning, offlineProviderAllowed } from './chat.js';
import { resolveSubscriptionProvider } from './oauth.js';
import { recordUsage } from './usage.js';
import * as LimitsService from './limits.js';
import { daemonCall, daemonOwns } from './engine/daemon.js';
import {
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_SYSTEM,
  compactedTranscript,
  compactionPlan,
  compactionUsageRecord,
  compactionRefusal,
  compactionSizes,
  continuedChat,
  summarizeWith,
  summaryMessage,
  summaryPrompt,
} from './turn-variants.js';

export { SUMMARY_CALL_TIMEOUT_MS, clip, transcriptText } from './turn-variants.js';

/**
 * Compacting a chat: summarize the older part of its transcript so the chat
 * can keep going inside the model's context window.
 *
 * The earlier messages are not deleted. A summary message marked `compaction`
 * goes in after them, and from then on a model is sent only that summary and
 * what follows it (`sinceCompaction`), while the chat still shows everything
 * above a divider. Or, when the user asks for it, the summary starts a new chat
 * and this one is left as it was.
 *
 * A long agentic chat is mostly tool output, so that is clipped before it is
 * summarized, the chunks are summarized a few at a time, every call has a time
 * limit, and progress goes out as `compaction` events so the chat can show it.
 * The pure half (what is summarized, the prompt, the edit) is turn-variants.ts.
 *
 * Under an engine daemon that owns compaction (`NEKKOD_OWNS=compaction`,
 * crates/nekkod/src/compaction.rs) the daemon runs it: this module becomes
 * its client and follows its `compaction` events for `isSessionCompacting`.
 */

/** What the daemon is told it owns when it runs compactions. */
export const DAEMON_COMPACTION = 'compaction';

interface Job {
  controller: AbortController;
  progress: CompactionProgress;
  promise: Promise<Session>;
}

const jobs = new Map<string, Job>();
/** The chats the daemon is compacting, from its `compaction` events. */
const daemonCompacting = new Set<string>();

let send: (event: AgentEvent) => void = () => {};
/** Where compaction progress events go (the host's agent event stream). */
export function setCompactionSender(fn: (event: AgentEvent) => void): void {
  send = fn;
}

/** Note the daemon's `compaction` events (the host hears every daemon event). */
export function observeCompaction(event: AgentEvent): void {
  if (event.type !== 'compaction') return;
  if (event.progress.state === 'running') daemonCompacting.add(event.sessionId);
  else daemonCompacting.delete(event.sessionId);
}

function daemon() {
  return daemonOwns(DAEMON_COMPACTION) ? daemonCall() : undefined;
}

export function isSessionCompacting(sessionId: string): boolean {
  return jobs.has(sessionId) || daemonCompacting.has(sessionId);
}

export function cancelSessionCompaction(sessionId: string): void | Promise<void> {
  const call = daemon();
  if (call) return call<void>('chat:cancelCompaction', sessionId);
  jobs.get(sessionId)?.controller.abort();
}

function report(sessionId: string, job: Job, patch: Partial<CompactionProgress>): void {
  job.progress = { ...job.progress, ...patch };
  send({ type: 'compaction', sessionId, progress: job.progress });
}

async function summarize(
  config: ProviderConfig,
  model: string,
  sessionId: string,
  text: string,
  contextWindow: number,
  signal: AbortSignal,
  onCall: (done: number, total: number) => void,
): Promise<string> {
  const provider = createProvider(config);
  const { maxOutputTokens } = compactionSizes(contextWindow);
  const onHeaders =
    config.kind === 'anthropic' && config.auth === 'subscription' && config.tokenKey
      ? (headers: Headers) => LimitsService.recordFromHeaders(config.tokenKey!, config.kind, headers)
      : undefined;

  const call = async (chunk: string): Promise<string> => {
    if (signal.aborted) throw new Error('Compaction cancelled.');
    const timeout = AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS);
    let answer = '';
    try {
      for await (const item of provider.chat({
        model,
        system: SUMMARY_SYSTEM,
        messages: [{ id: randomUUID(), role: 'user', content: summaryPrompt(chunk), createdAt: Date.now() }],
        maxOutputTokens,
        // A summary needs no deliberation, and a reasoning model left on its
        // default effort spends minutes per chunk.
        effort: 'low',
        think: false,
        signal: AbortSignal.any([signal, timeout]),
        onHeaders,
      })) {
        if (item.type === 'text') answer += item.delta;
        if (item.type === 'usage') recordUsage(compactionUsageRecord(config, model, sessionId, item, Date.now()));
        if (item.type === 'done' && config.auth === 'subscription' && config.tokenKey) {
          LimitsService.poll(config.tokenKey).catch(() => {});
        }
      }
    } catch (error) {
      if (signal.aborted) throw new Error('Compaction cancelled.');
      if (timeout.aborted) throw new Error(`The model took more than ${SUMMARY_CALL_TIMEOUT_MS / 60_000} minutes on one part of the summary.`);
      throw error;
    }
    if (signal.aborted) throw new Error('Compaction cancelled.');
    return answer;
  };

  return summarizeWith(text, contextWindow, call, onCall);
}

/**
 * Compact a chat. With `newChat`, the summary starts a new chat (same project,
 * folders and model) instead, and this one is left untouched; asked while a
 * compaction is already running, `newChat` redirects that one. Resolves with
 * the chat the summary landed in.
 */
export function compactSession(sessionId: string, opts?: { newChat?: boolean } | null): Promise<Session> {
  const call = daemon();
  if (call) return call<Session>('chat:compact', sessionId, opts ?? null);
  try {
    // Options cross IPC, where an omitted argument can arrive as null.
    return start(sessionId, !!opts?.newChat);
  } catch (error) {
    return Promise.reject(error);
  }
}

function start(sessionId: string, newChat: boolean): Promise<Session> {
  const running = jobs.get(sessionId);
  if (running) {
    if (newChat && running.progress.target !== 'new') report(sessionId, running, { target: 'new' });
    return running.promise;
  }
  if (isChatRunning(sessionId)) throw new Error('Wait for the current reply to finish before compacting.');

  const session = getSession(sessionId);
  const provider = session ? getSettings().providers.find((item) => item.id === session.providerId) : undefined;
  const refusal = compactionRefusal(session, provider, !!provider && offlineProviderAllowed(provider));
  if (refusal) throw new Error(refusal);

  const job: Job = {
    controller: new AbortController(),
    progress: { state: 'running', done: 0, total: 0, target: newChat ? 'new' : 'here' },
    promise: Promise.resolve(session!),
  };
  jobs.set(sessionId, job);
  report(sessionId, job, {});
  job.promise = run(session!, job).then(
    (landed) => {
      report(sessionId, job, { state: 'done', ...(landed.id !== sessionId ? { newSessionId: landed.id } : {}) });
      return landed;
    },
    (error: Error) => {
      report(sessionId, job, job.controller.signal.aborted ? { state: 'cancelled' } : { state: 'failed', error: error.message });
      throw error;
    },
  ).finally(() => {
    if (jobs.get(sessionId) === job) jobs.delete(sessionId);
  });
  return job.promise;
}

async function run(session: Session, job: Job): Promise<Session> {
  const sessionId = session.id;
  const signal = job.controller.signal;
  const provider = getSettings().providers.find((item) => item.id === session.providerId)!;
  const resolved = await resolveSubscriptionProvider(provider);
  // The window the model was last loaded with when a turn found out, else the
  // id's guess: summary chunks sized for a 128k guess overflow an 8k local model.
  const contextWindow = knownContextWindow(session.providerId, session.modelId);

  const plan = compactionPlan(session.messages, contextWindow);
  if ('error' in plan) throw new Error(plan.error);

  const summary = await summarize(
    resolved,
    session.modelId!,
    sessionId,
    plan.text,
    contextWindow,
    signal,
    (done, total) => report(sessionId, job, { done, total }),
  );
  if (signal.aborted) throw new Error('Compaction cancelled.');

  const latest = getSession(sessionId);
  if (!latest || latest.updatedAt !== session.updatedAt || JSON.stringify(latest.messages) !== JSON.stringify(session.messages)) {
    throw new Error('The conversation changed during compaction. The original history was kept.');
  }
  const marker = summaryMessage(`compact_${randomUUID()}`, summary, plan.summarized, plan.createdAt ?? Date.now());

  if (job.progress.target === 'new') {
    const next = forkSession(sessionId);
    if (!next) throw new Error('Session not found.');
    const continued = continuedChat(latest.title, marker, plan.recent);
    next.title = continued.title;
    next.messages = continued.messages;
    saveSession(next);
    return next;
  }

  const compacted = compactedTranscript(latest.messages, plan, marker);
  if ('error' in compacted) throw new Error(compacted.error);
  latest.messages = compacted.messages;
  saveSession(latest);
  return latest;
}
