import React from 'react';

/*
 * Nekko for the Windows install help videos, in the house style of the website demos:
 * just her head, peeking over the top edge of the card with her paws on it.
 *
 * The head, eyes and mouth are the app's own PixelHead (src/renderer/components/Mascot.tsx).
 * She has no body or arms here on purpose. Instead of pointing, she ducks behind the edge,
 * pops up above whatever matters and looks at it.
 *
 * Motion rules that keep her charm:
 * - Nothing is scaled, stretched or rotated. Every offset is a whole grid unit.
 * - Moving along the edge is a duck, a hidden move and a pop back up, never a slide.
 * - Emphasis is a one or two unit hop of the head while the paws stay on the edge.
 * - Idle life is a blink every few seconds and pupils that follow the action.
 */

const PLUM = '#190019';
const LINE = '#ffffff';
const MOUTH = '#c99bb3';

const HEAD = 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z';
const EYES = {
  open: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  happy: 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z',
  closed: 'M10 17H14V18H10Z M19 17H23V18H19Z',
} as const;
const PAWS = 'M5 26H11V29H5Z M21 26H27V29H21Z';

export type Mood = keyof typeof EYES;
export type Look = { x: number; y: number };

function eyesFor(frame: number, mood: Mood, seed: number): Mood {
  if (mood !== 'open') return mood;
  // A three frame blink every 3.2 s.
  return (frame + seed) % 96 < 3 ? 'closed' : 'open';
}

function Head({ eyes, look, dx = 0, dy = 0 }: { eyes: Mood; look?: Look; dx?: number; dy?: number }) {
  const ex = eyes === 'open' && look ? look.x : 0;
  const ey = eyes === 'open' && look ? look.y : 0;
  return (
    <g transform={`translate(${dx} ${dy})`}>
      <path d={HEAD} fill={PLUM} stroke={LINE} strokeWidth={2} strokeLinejoin="miter" />
      <path d={EYES[eyes]} fill={LINE} transform={`translate(${ex} ${ey})`} />
      <path d="M15 20H17V21H15Z" fill={MOUTH} />
    </g>
  );
}

export type Peek = {
  /** Stage x of her centre. */
  x: number;
  /** 0 hidden behind the edge, 1 fully up with paws on it. */
  rise: number;
  mood?: Mood;
  look?: Look;
  /** Head hop in whole units, paws stay put. */
  lift?: number;
  /** Head shake offset in whole units. */
  headDx?: number;
};

/** Nekko peeking over a horizontal edge at (x, edgeY), drawn at u px per grid unit. */
export function PeekNekko({ frame, x, edgeY, u, peek, seed = 0 }: { frame: number; x: number; edgeY: number; u: number; peek: Peek; seed?: number }) {
  const h = 30; // two spare units above her ears for hops
  const hidden = Math.round((1 - Math.max(0, Math.min(1, peek.rise))) * 28);
  const eyes = eyesFor(frame, peek.mood ?? 'open', seed);
  const left = Math.round(x / u) * u - 16 * u;
  return (
    <div style={{ position: 'absolute', left, top: Math.round(edgeY) - h * u, width: 32 * u, height: h * u + 2 * u, overflow: 'hidden', pointerEvents: 'none' }}>
      <svg style={{ position: 'absolute', left: 0, top: (hidden + 2) * u }} width={32 * u} height={30 * u} viewBox="0 0 32 30" shapeRendering="crispEdges">
        <Head eyes={eyes} look={peek.look} dx={peek.headDx ?? 0} dy={-(peek.lift ?? 0)} />
        <path d={PAWS} fill={PLUM} stroke={LINE} strokeWidth={2} />
      </svg>
    </div>
  );
}

/** Her head alone, for end cards. */
export function NekkoHead({ frame, size, mood = 'open', look, seed = 0 }: { frame: number; size: number; mood?: Mood; look?: Look; seed?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges" style={{ overflow: 'visible' }}>
      <Head eyes={eyesFor(frame, mood, seed)} look={look} />
    </svg>
  );
}

/** A tiny four point pixel sparkle that twinkles between two sizes. */
export function Sparkle({ frame, x, y, u, color = '#ffffff' }: { frame: number; x: number; y: number; u: number; color?: string }) {
  const big = Math.floor(frame / 6) % 2 === 0;
  const d = big ? 'M2 0H3V2H5V3H3V5H2V3H0V2H2Z' : 'M2 1H3V2H4V3H3V4H2V3H1V2H2Z';
  return (
    <svg style={{ position: 'absolute', left: x, top: y }} width={5 * u} height={5 * u} viewBox="0 0 5 5" shapeRendering="crispEdges">
      <path d={d} fill={color} />
    </svg>
  );
}

/**
 * Where she peeks over time. She pops up at `start`. Each move ducks her behind the edge
 * (6 frames), moves her while hidden, and pops her back up (6 frames).
 */
export function peekTrack(frame: number, start: number, startX: number, moves: { f: number; x: number }[]) {
  const up = (t: number) => Math.max(0, Math.min(1, t));
  let x = startX;
  let rise = up((frame - start) / 8);
  for (const m of moves) {
    if (frame < m.f) break;
    if (frame < m.f + 6) { rise = 1 - up((frame - m.f) / 6); break; }
    x = m.x;
    rise = up((frame - m.f - 8) / 6);
  }
  return { x, rise };
}

/** A hop of the head: `n` units up for a few frames from each start frame. */
export function hops(frame: number, starts: number[], n = 1, dur = 6) {
  return starts.some((s) => frame >= s && frame < s + dur) ? n : 0;
}
