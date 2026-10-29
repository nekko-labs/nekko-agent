import { useLayoutEffect, useState } from 'react';

/** Retain outgoing content only for its CSS transition; reopening cancels removal. */
export function usePanelPresence(show: boolean) {
  const [retained, setRetained] = useState(show);
  useLayoutEffect(() => {
    if (show) { setRetained(true); return; }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) { setRetained(false); return; }
    const finish = () => setRetained(false);
    const timer = setTimeout(finish, 220);
    const changed = () => { if (motion.matches) finish(); };
    motion.addEventListener?.('change', changed);
    return () => { clearTimeout(timer); motion.removeEventListener?.('change', changed); };
  }, [show]);
  return show || retained;
}
