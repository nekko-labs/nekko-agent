import React, { useEffect, useState } from 'react';
import { isAuroraHour } from '../seasonal.js';

/** Where each flake falls (left %), its size (px) and how long one fall takes (s). */
const FLAKES: Array<{ left: number; size: number; fall: number }> = [
  { left: 5, size: 10, fall: 34 }, { left: 17, size: 7, fall: 41 }, { left: 29, size: 12, fall: 30 },
  { left: 41, size: 8, fall: 45 }, { left: 53, size: 11, fall: 37 }, { left: 66, size: 7, fall: 43 },
  { left: 78, size: 12, fall: 32 }, { left: 90, size: 9, fall: 39 },
];
/** The hidden snow cat: one flake shaped like Nekko's head, on its own slow fall. */
const SNOW_CAT = { left: 60, size: 14, fall: 97 };
/** How often to look at the clock for the aurora. */
const AURORA_CHECK_MS = 5 * 60_000;

function usePageHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/** True while it is late at night (seasonal.ts), re-read every few minutes. */
function useAuroraHour(now: () => Date) {
  const [aurora, setAurora] = useState(() => isAuroraHour(now()));
  useEffect(() => {
    const timer = setInterval(() => setAurora(isAuroraHour(now())), AURORA_CHECK_MS);
    return () => clearInterval(timer);
  }, [now]);
  return aurora;
}

const defaultNow = () => new Date();

/**
 * Winter's backdrop: sparse, faint snow drifting down the window and a soft
 * drift along the bottom. Decorative only: it never intercepts input, and it
 * pauses while the window is hidden. Three things are left for people to find
 * (spec/brand/winter-theme.md): one flake is Nekko's head, the drift slowly
 * piles up over the first hour the app is open, and late at night a faint
 * aurora shimmers along the top.
 */
export function WinterBackground({ now = defaultNow }: { now?: () => Date }) {
  const hidden = usePageHidden();
  const aurora = useAuroraHour(now);
  return (
    <div className={`winter-background${hidden ? ' is-paused' : ''}`} aria-hidden="true">
      {aurora && <div className="winter-aurora" data-winter-egg="aurora" />}
      {FLAKES.map(({ left, size, fall }, i) => (
        <svg key={left} className="winter-flake" viewBox="0 0 24 24" width={size} height={size}
          style={{ left: `${left}%`, animationDelay: `${-i * 5.5}s`, animationDuration: `${fall}s` }}>
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
            <path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7" />
            <path d="M9.5 3.8 12 6l2.5-2.2M9.5 20.2 12 18l2.5 2.2" />
          </g>
        </svg>
      ))}
      <svg className="winter-flake winter-snow-cat" data-winter-egg="snow-cat" viewBox="0 0 32 32" width={SNOW_CAT.size} height={SNOW_CAT.size}
        shapeRendering="crispEdges" style={{ left: `${SNOW_CAT.left}%`, animationDelay: '-20s', animationDuration: `${SNOW_CAT.fall}s` }}>
        <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="currentColor" />
        <path d="M11 15H13V18H11Z M20 15H22V18H20Z" fill="var(--paper)" />
      </svg>
      <svg className="winter-drift" data-winter-egg="drift" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0 60V34C90 22 170 18 260 28S430 46 520 34 700 10 800 22 980 46 1080 32 1170 20 1200 24V60Z" fill="currentColor" />
      </svg>
    </div>
  );
}
