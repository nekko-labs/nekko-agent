import type { AgentEvent, Session } from '@nekko-agent/shared';
import { estimateTranscriptTokens, isContextOverflowError } from '@nekko-agent/shared';

/**
 * Keeping a chat going when it runs out of context, with nobody watching.
 *
 * The loop already keeps a run inside the window where it can (fit.ts) and
 * retries an overflow once with older tool output left out. When even that
 * does not fit, the reply ends with an overflow error. This compacts the chat
 * and sends it on, so the work continues instead of parking on a banner until
 * someone clicks Retry, which on a small local model happens every few steps.
 *
 * It also compacts after a finished reply that left the transcript near the
 * window, which the chat pane only does while it is open; a chat driven by an
 * agent watch, a queue, or a phone has no pane open.
 *
 * Both engine routes report here: the in-process loop's events and the
 * daemon's (relayed through `turn:event`) reach the host's event bus alike.
 */

/** Automatic continuations a chat gets before it waits for the user. Reset by a reply that finishes. */
export const MAX_AUTO_CONTINUES = 2;
/**
 * Share of the window the transcript alone may fill before a finished reply
 * triggers compaction. The pane's warning counts the whole prompt (system,
 * guidelines, memory) and acts at 95%; the transcript alone at 85% is about
 * the same point with ordinary system text.
 */
export const COMPACT_AFTER_REPLY = 0.85;
/** How long to wait for the ending turn's after-work to let go of the chat. */
const SETTLE_MS = 30_000;
const POLL_MS = 250;

/** The visible user turn that carries an overflowed chat on after compaction. */
export const CONTINUE_AFTER_COMPACTION =
  'The conversation was compacted automatically because it no longer fit the model\'s context window. ' +
  'Continue the task from where the summary leaves off: work it lists as done is done, so do not repeat it. ' +
  'Re-read a file or re-run a check only when you need its current contents. If the task was already finished, give the final answer.';

export interface AutoContinueDeps {
  /** Subscribe to every agent event; returns an unsubscribe. */
  onEvent: (fn: (e: AgentEvent) => void) => () => void;
  getSession: (id: string) => Session | null | undefined;
  isRunning: (id: string) => boolean;
  /** The window last used for this chat's model. */
  contextWindow: (providerId: string | undefined, modelId: string | undefined) => number;
  compact: (id: string) => Promise<unknown>;
  /** Send a user turn on the chat's own provider and model. */
  send: (session: Session, text: string) => Promise<void>;
  /** Tell the chat what happened, when it could not carry on. */
  notify: (e: AgentEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether this chat is one the host may compact and continue by itself. */
export function eligible(session: Session | null | undefined): session is Session {
  return !!session && !session.incognito && !session.archivedAt && !session.parentSessionId && !session.trainingRunId
    && !!session.providerId && !!session.modelId && !session.queue?.length;
}

export function startAutoContinue(deps: AutoContinueDeps): () => void {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const continues = new Map<string, number>();
  const busy = new Set<string>();

  /** Wait for the ending turn to let go of the chat; false when it never does. */
  async function settled(id: string): Promise<boolean> {
    const until = now() + SETTLE_MS;
    while (deps.isRunning(id)) {
      if (now() > until) return false;
      await sleep(POLL_MS);
    }
    return true;
  }

  async function afterOverflow(id: string): Promise<void> {
    const used = continues.get(id) ?? 0;
    if (used >= MAX_AUTO_CONTINUES) {
      deps.notify({ type: 'error', sessionId: id, message: `This chat ran out of context ${used + 1} times in a row and was not continued again automatically. Compact it or start a new chat from its summary.` });
      return;
    }
    if (!(await settled(id))) return;
    const session = deps.getSession(id);
    if (!eligible(session)) return;
    continues.set(id, used + 1);
    try {
      await deps.compact(id);
    } catch (e) {
      deps.notify({ type: 'error', sessionId: id, message: `The chat ran out of context and could not be compacted: ${(e as Error).message}` });
      return;
    }
    if (deps.isRunning(id)) return; // the user sent something meanwhile
    const fresh = deps.getSession(id);
    if (!eligible(fresh)) return;
    await deps.send(fresh, CONTINUE_AFTER_COMPACTION);
  }

  async function afterReply(id: string): Promise<void> {
    if (!(await settled(id))) return;
    const session = deps.getSession(id);
    if (!eligible(session) || !session.messages.length) return;
    const window = deps.contextWindow(session.providerId, session.modelId);
    if (!window || estimateTranscriptTokens(session.messages) < window * COMPACT_AFTER_REPLY) return;
    await deps.compact(id).catch(() => {});
  }

  function run(id: string, work: (id: string) => Promise<void>): void {
    if (busy.has(id)) return;
    busy.add(id);
    void work(id).catch(() => {}).finally(() => busy.delete(id));
  }

  return deps.onEvent((e) => {
    if (e.type === 'error' && isContextOverflowError(e.message)) run(e.sessionId, afterOverflow);
    else if (e.type === 'done') {
      continues.delete(e.sessionId);
      run(e.sessionId, afterReply);
    }
  });
}
