import { useEffect, useState } from 'react';
import type { ServedSite } from '@nekko-agent/shared';

/** How often the Browsers view looks again while it is on screen. */
const EVERY_MS = 5000;

/**
 * The web pages served on this computer (`servers:list`, #2824), read while
 * `active` (the Agents panel shows Browsers) and the window is visible.
 * `null` until the first answer; empty where the host cannot look.
 */
export function useServedSites(active: boolean): ServedSite[] | null {
  const [sites, setSites] = useState<ServedSite[] | null>(null);
  useEffect(() => {
    if (!active) return;
    const list = window.nekko?.serversList;
    if (!list) { setSites([]); return; }
    let disposed = false;
    let timer: number | undefined;
    let reading = false;
    // One read at a time: coming back into view while one is out waits for it.
    const read = () => {
      window.clearTimeout(timer);
      if (reading || document.visibilityState === 'hidden') return;
      reading = true;
      void list().then((r) => { if (!disposed) setSites(r?.servers ?? []); })
        .catch(() => { if (!disposed) setSites((s) => s ?? []); })
        .finally(() => { reading = false; if (!disposed) timer = window.setTimeout(read, EVERY_MS); });
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', read); };
  }, [active]);
  return sites;
}
