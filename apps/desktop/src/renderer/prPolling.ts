/**
 * One timer for every card's PR poll, not one per card. Cards subscribe by
 * chat; every 20 s (and when the window is focused or shown) the chats that
 * are subscribed are read together, in one request when `refreshMany` is given
 * (`pr:sessionListMany`), else each by its own `refresh`.
 */
const polls = new Map<string, { count: number; refresh: () => Promise<void> }>();
let many: ((ids: string[]) => Promise<void>) | undefined;
let stopTimers: (() => void) | undefined;
let busy = false;

async function run() {
  if (busy || document.hidden || polls.size === 0) return;
  busy = true;
  try {
    const ids = [...polls.keys()];
    if (many && ids.length > 1) await many(ids);
    else await Promise.all(ids.map((id) => polls.get(id)?.refresh()));
  } catch { /* Keep the last known state on network failure. */ }
  finally { busy = false; }
}

function start() {
  const timer = setInterval(() => void run(), 20_000);
  const focus = () => void run();
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', focus);
  stopTimers = () => {
    clearInterval(timer);
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', focus);
    stopTimers = undefined;
  };
}

export function subscribePrPolling(
  sessionId: string,
  refresh: () => Promise<void>,
  refreshMany?: (ids: string[]) => Promise<void>,
): () => void {
  let poll = polls.get(sessionId);
  if (!poll) {
    poll = { count: 0, refresh };
    polls.set(sessionId, poll);
  }
  // Chat load already fetches after paint; polling must not delay its first frame.
  if (refreshMany) many = refreshMany;
  if (!stopTimers) start();
  poll.count++;
  const mine = poll;
  return () => {
    if (--mine.count > 0) return;
    if (polls.get(sessionId) === mine) polls.delete(sessionId);
    if (polls.size === 0) { stopTimers?.(); many = undefined; }
  };
}
