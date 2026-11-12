import type { IssueInfo, PrInfo } from '@nekko-agent/shared';

/** How long a looked-up GitHub state (a PR or an issue) is trusted on screen. */
export const LIVE_STATE_FRESH_MS = 60_000;

/**
 * Open (or draft) PRs and open issues can still change; merged and closed are
 * final, so nothing re-reads them.
 */
export function isLiveState(info: PrInfo | IssueInfo | null | undefined): boolean {
  return info?.state === 'open';
}

const subscribers = new Set<() => void>();
let stop: (() => void) | null = null;

function tick(): void {
  if (document.hidden) return;
  for (const fn of [...subscribers]) {
    try { fn(); } catch { /* One subscriber's failure never stops the others. */ }
  }
}

/**
 * One shared re-check for GitHub states shown on screen: every
 * `LIVE_STATE_FRESH_MS` while the window is visible, and at once when it
 * regains focus or becomes visible. The timer runs only while something is
 * subscribed, and a hidden window skips the tick. Subscribers decide what is
 * stale, so a tick costs nothing when every state is fresh or final.
 */
export function onLiveStateTick(fn: () => void): () => void {
  subscribers.add(fn);
  if (!stop) {
    const timer = setInterval(tick, LIVE_STATE_FRESH_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    stop = () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && stop) { stop(); stop = null; }
  };
}
