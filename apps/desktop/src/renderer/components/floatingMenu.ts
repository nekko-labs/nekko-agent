import React, { useLayoutEffect, useState } from 'react';

/**
 * Place a menu next to its trigger in a portal, above it when there is more room
 * there. The agent window clips its overflow, so a menu drawn inside its footer
 * would be cut off; this one floats over everything instead.
 */
export function useFloatingMenu(open: boolean, anchor: React.RefObject<HTMLElement | null>, width: number, tallest = 360) {
  const [style, setStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const above = Math.max(0, r.top - 16);
      const below = Math.max(0, window.innerHeight - r.bottom - 16);
      const w = Math.min(width, window.innerWidth - 16);
      setStyle({
        width: w,
        left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)),
        maxHeight: Math.min(tallest, Math.max(above, below)),
        ...(above >= below ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    place();
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, anchor, width, tallest]);
  return style;
}
