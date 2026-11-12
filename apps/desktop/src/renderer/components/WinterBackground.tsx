import React, { useCallback, useEffect, useState } from 'react';
import { isAuroraHour } from '../seasonal.js';

/**
 * Eight snowflake designs. Each is one arm, drawn pointing up from the centre
 * of a 24 x 24 box and repeated six times around it, plus an optional centre.
 */
export const SNOWFLAKE_TYPES: ReadonlyArray<{ arm: string; center?: string }> = [
  // Classic: a chevron near the tip.
  { arm: 'M12 12V2M9.6 4.4 12 6.6l2.4-2.2' },
  // Fern: two chevrons, the lower one wider.
  { arm: 'M12 12V2M10.5 3.5 12 5l1.5-1.5M9.9 5.9 12 7.6l2.1-1.7' },
  // Star: plain arms, each ending in a small round bead.
  { arm: 'M12 12V4.8M10.8 3.2a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0' },
  // Ladder: two crossbars on every arm.
  { arm: 'M12 12V2M10 4.6h4M10.6 7.6h2.8' },
  // Crystal: arms ending in open diamonds.
  { arm: 'M12 12V6.4M12 6.4 10.4 4 12 1.6 13.6 4Z' },
  // Arrow: tips and a mid-arm chevron both pointing outward.
  { arm: 'M12 12V2M10.2 3.8 12 2l1.8 1.8M10.7 6.5 12 5.2l1.3 1.3' },
  // Plate: a hexagon centre with short tipped arms.
  { arm: 'M12 8.6V2.4M10.6 4.4 12 5.8l1.4-1.4', center: 'M12 8.6l2.98 1.7v3.4L12 15.4l-2.98-1.7v-3.4Z' },
  // Dendrite: side branches that fan out at sixty degrees, around a ring.
  { arm: 'M12 9.6V2M12 7.2 9.4 5.6M12 7.2l2.6-1.6M12 4.6l-1.6-1M12 4.6l1.6-1', center: 'M9.6 12a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0-4.8 0' },
];
/** How many flakes are in the air at once. */
const FLAKE_COUNT = 10;
/** Flake size range (px) and how long one fall takes (s): large and always slow. */
const SIZE = { min: 22, max: 40 };
const FALL = { min: 48, max: 96 };
/** How often to look at the clock for the aurora. */
const AURORA_CHECK_MS = 5 * 60_000;

type Flake = { id: number; type: number; left: number; size: number; fall: number; delay: number; spin: 1 | -1 };

let nextFlakeId = 0;
/**
 * A flake with a random design, column, size and speed. The first batch starts
 * part-way through its fall so the window opens with snow already in the air;
 * later flakes start at the top after a short random pause.
 */
function randomFlake(random: () => number, first: boolean): Flake {
  const between = ({ min, max }: { min: number; max: number }) => min + random() * (max - min);
  const fall = Math.round(between(FALL));
  return {
    id: nextFlakeId++,
    type: Math.floor(random() * SNOWFLAKE_TYPES.length) % SNOWFLAKE_TYPES.length,
    left: Math.round(between({ min: 2, max: 96 })),
    size: Math.round(between(SIZE)),
    fall,
    delay: first ? -Math.round(random() * fall) : Math.round(random() * 8),
    spin: random() < 0.5 ? 1 : -1,
  };
}

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
 * Winter's backdrop: large, faint snowflakes in eight designs drifting slowly
 * down the window, and a soft drift along the bottom. Each flake picks its
 * design, column, size and speed at random, and when it lands a new random
 * flake takes its place. Decorative only: it never intercepts input, and it
 * pauses while the window is hidden. Two things are left for people to find
 * (spec/brand/winter-theme.md): the drift slowly piles up over the first hour
 * the app is open, and late at night a faint aurora shimmers along the top.
 */
export function WinterBackground({ now = defaultNow, random = Math.random }: { now?: () => Date; random?: () => number }) {
  const hidden = usePageHidden();
  const aurora = useAuroraHour(now);
  const [flakes, setFlakes] = useState(() => Array.from({ length: FLAKE_COUNT }, () => randomFlake(random, true)));
  const landed = useCallback((id: number) => {
    setFlakes((current) => current.map((flake) => (flake.id === id ? randomFlake(random, false) : flake)));
  }, [random]);
  return (
    <div className={`winter-background${hidden ? ' is-paused' : ''}`} aria-hidden="true">
      {aurora && <div className="winter-aurora" data-winter-egg="aurora" />}
      {flakes.map(({ id, type, left, size, fall, delay, spin }) => {
        const { arm, center } = SNOWFLAKE_TYPES[type];
        return (
          <svg key={id} className={`winter-flake${spin < 0 ? ' is-ccw' : ''}`} data-flake-type={type} viewBox="0 0 24 24" width={size} height={size}
            style={{ left: `${left}%`, animationDelay: `${delay}s`, animationDuration: `${fall}s` }}
            onAnimationEnd={() => landed(id)}>
            <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none">
              {[0, 60, 120, 180, 240, 300].map((angle) => (
                <path key={angle} d={arm} transform={angle ? `rotate(${angle} 12 12)` : undefined} />
              ))}
              {center && <path d={center} />}
            </g>
          </svg>
        );
      })}
      <svg className="winter-drift" data-winter-egg="drift" viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d="M0 60V34C90 22 170 18 260 28S430 46 520 34 700 10 800 22 980 46 1080 32 1170 20 1200 24V60Z" fill="currentColor" />
      </svg>
    </div>
  );
}
