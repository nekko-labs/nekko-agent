import { useEffect, useState } from 'react';
import type { GitStatus } from '@nekko-agent/shared';
import { afterPaint } from './afterPaint.js';

/** How often a visible card re-reads git. The host caches under this anyway. */
const POLL_MS = 15_000;

/**
 * The git position of a workspace folder, for the sidebar cards.
 *
 * Polled rather than pushed: branch changes and commits happen in the user's
 * own terminal as often as they happen through the agent, so there is no event
 * to subscribe to. The host caches and coalesces per folder, so several cards
 * over one repo cost a single `git` however many of them are on screen.
 *
 * Returns null while the first read is in flight and for a folder that is not a
 * repository, so a caller can render nothing without special-casing either.
 */
export function useGitStatus(workspaceId: string | undefined, checkoutMode?: boolean): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    let live = true;
    let inFlight = false;
    const read = () => {
      // One read at a time, and none while the window is hidden: a stalled
      // engine used to collect hundreds of queued reads from the cards.
      if (inFlight || document.hidden) return;
      inFlight = true;
      window.nekko
        .getGitStatus(workspaceId)
        .then((s) => { if (live) setStatus(s.repo ? s : null); })
        .catch(() => { if (live) setStatus(null); })
        .finally(() => { inFlight = false; });
    };
    // Back from hidden: catch up at once rather than on the next tick.
    const onVisible = () => { if (!document.hidden) read(); };
    document.addEventListener('visibilitychange', onVisible);
    // The first read waits for the first frame: a card or pane that just
    // appeared paints before it asks.
    const cancel = afterPaint(read);
    const t = setInterval(read, POLL_MS);
    return () => { live = false; cancel(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [workspaceId, checkoutMode]);

  return status;
}
