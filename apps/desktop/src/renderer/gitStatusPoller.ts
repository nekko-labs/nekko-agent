import type { GitStatus } from '@nekko-agent/shared';
import { afterPaint } from './afterPaint.js';

/**
 * How often a shown folder's git state is re-read when nothing told us it
 * changed. The daemon says so when it changes git itself (`git:changed`: stage,
 * commit, push, switch, PR create); this is for what happens in the user's own
 * terminal or in an agent's shell. The host caches under this anyway.
 */
export const GIT_POLL_MS = 30_000;
/** A push event re-reads every shown folder; several in a row become one read. */
const PUSH_DEBOUNCE_MS = 300;

type Listener = (status: GitStatus | null) => void;

interface Poll {
  listeners: Set<Listener>;
  /** The last read: `undefined` before the first. */
  last: GitStatus | null | undefined;
  inFlight: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  cancelFirst: () => void;
}

/** One poller per workspace or chat key, however many cards and panes show it. */
const polls = new Map<string, Poll>();
let offGlobal: (() => void) | undefined;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function read(key: string) {
  const poll = polls.get(key);
  // One read at a time, and none while the window is hidden: a stalled engine
  // used to collect hundreds of queued reads from the cards.
  if (!poll || poll.inFlight || document.hidden) return;
  poll.inFlight = true;
  window.nekko
    .getGitStatus(key)
    .then((s) => (s.repo ? s : null), () => null)
    .then((status) => {
      poll.last = status;
      poll.listeners.forEach((l) => l(status));
    })
    .finally(() => { poll.inFlight = false; });
}

const readAll = () => { for (const key of polls.keys()) read(key); };

function attachGlobal() {
  if (offGlobal) return;
  // Back from hidden: catch up at once rather than on the next tick.
  const onVisible = () => { if (!document.hidden) readAll(); };
  document.addEventListener('visibilitychange', onVisible);
  const offPush = window.nekko.onGitChanged?.(() => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(readAll, PUSH_DEBOUNCE_MS);
  });
  offGlobal = () => {
    document.removeEventListener('visibilitychange', onVisible);
    offPush?.();
    clearTimeout(pushTimer);
    offGlobal = undefined;
  };
}

/**
 * Follow the git state of a workspace folder (or `session:<id>` chat checkout).
 * The first subscriber for a key starts its one poll; later ones are handed the
 * last read at once and share the rest. `listener` is told every read, `null`
 * for a folder that is not a repository.
 */
export function subscribeGitStatus(key: string, listener: Listener): () => void {
  let poll = polls.get(key);
  if (!poll) {
    const created: Poll = { listeners: new Set(), last: undefined, inFlight: false, timer: undefined, cancelFirst: () => {} };
    polls.set(key, created);
    attachGlobal();
    // The first read waits for the first frame: a card or pane that just
    // appeared paints before it asks.
    created.cancelFirst = afterPaint(() => read(key));
    created.timer = setInterval(() => read(key), GIT_POLL_MS);
    poll = created;
  } else if (poll.last !== undefined) {
    listener(poll.last);
  }
  poll.listeners.add(listener);
  const mine = poll;
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size > 0) return;
    mine.cancelFirst();
    clearInterval(mine.timer);
    if (polls.get(key) === mine) polls.delete(key);
    if (polls.size === 0) offGlobal?.();
  };
}

/** The last read of a key someone is following, for a card's first render. */
export function lastGitStatus(key: string): GitStatus | null {
  return polls.get(key)?.last ?? null;
}

/** Read a followed key now (a chat changed how it checks out, so its folder did). */
export function refreshGitStatus(key: string): void {
  read(key);
}
