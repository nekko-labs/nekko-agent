/**
 * Which chats' agent event stream this window takes from the engine.
 *
 * Every window used to receive every chat's events: with six chats streaming
 * on the Agents wall, each window parsed every other chat's tokens (#551).
 * Now a chat pane that is mounted claims its chat (and the sub-agents it
 * delegated to, whose rail and cues it shows), and the engine sends this
 * window those chats' streams only. Every chat's summary events still arrive
 * whatever is claimed: a turn's first event, a wait on a person and the event
 * after it, `session_meta`, `compaction`, `done` and `error`
 * (crates/nekkod/src/hub.rs). That is all the sidebar, the board, the
 * notifications, the design board and auto-compaction read of a chat nobody
 * shows.
 *
 * Claims are counted, since the same chat can be mounted twice (the wall and
 * a composer). The engine is told once per change (a microtask), and a chat claimed
 * mid-turn is sent the turn so far (`agent:replay`, folded by liveRuns).
 */

import { useEffect } from 'react';
import type { NekkoApi, SessionSummary } from '@nekko-agent/shared';

type Family = Pick<SessionSummary, 'id' | 'parentSessionId'>;
/** Where the chat list comes from (the store, given by `startAgentSubscription`). */
interface SessionSource {
  list: () => Family[];
  /** Calls back on every change; returns the unsubscribe. */
  watch: (fn: () => void) => () => void;
}
let source: SessionSource = { list: () => [], watch: () => () => {} };

const claims = new Map<string, number>();
let scheduled = false;
/** What the engine was last told; null: nothing yet (it sends every chat's stream). */
let lastSent: string | null = null;

type Api = Pick<NekkoApi, 'subscribeAgentEvents'>;
const api = (): Api | undefined => (typeof window === 'undefined' ? undefined : (window as { nekko?: Api }).nekko);

/** The claimed chats and their sub-agents, sorted. */
export function subscribedSessions(sessions: Family[] = source.list()): string[] {
  const ids = new Set(claims.keys());
  // A pane shows its children's activity (the sub-agent rail and cues), so
  // their streams come with it; children of children too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sessions) {
      if (s.parentSessionId && ids.has(s.parentSessionId) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return [...ids].sort();
}

function flush(): void {
  scheduled = false;
  const ids = subscribedSessions();
  const key = ids.join(',');
  if (key === lastSent) return;
  lastSent = key;
  api()?.subscribeAgentEvents?.(ids);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // A microtask, not a frame: a pane mounting mid-turn wants its replay now.
  queueMicrotask(flush);
}

/** Claim a chat's stream for this window; returns the release. */
export function claimAgentEvents(sessionId: string): () => void {
  claims.set(sessionId, (claims.get(sessionId) ?? 0) + 1);
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (claims.get(sessionId) ?? 1) - 1;
    if (n > 0) claims.set(sessionId, n);
    else claims.delete(sessionId);
    schedule();
  };
}

/** A mounted component that shows this chat's live run claims its stream. */
export function useAgentEventClaim(sessionId: string | null | undefined): void {
  useEffect(() => (sessionId ? claimAgentEvents(sessionId) : undefined), [sessionId]);
}

/**
 * Start narrowing for the whole app: until now the window took every chat's
 * stream (the default, kept for anything older). Re-checked as the session
 * list changes, so a sub-agent spawned under a shown chat joins it.
 */
export function startAgentSubscription(sessions: SessionSource): () => void {
  if (!api()?.subscribeAgentEvents) return () => {};
  source = sessions;
  schedule();
  let parents = '';
  const off = sessions.watch(() => {
    const next = sessions.list().filter((x) => x.parentSessionId).map((x) => `${x.id}<${x.parentSessionId}`).join(',');
    if (next !== parents) {
      parents = next;
      schedule();
    }
  });
  return () => {
    off();
    api()?.subscribeAgentEvents?.(null);
    lastSent = null;
  };
}

/** Tests only. */
export function __resetAgentSubscription(): void {
  source = { list: () => [], watch: () => () => {} };
  claims.clear();
  scheduled = false;
  lastSent = null;
}
