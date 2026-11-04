import React from 'react';
import { PixelHead } from './Mascot.js';
import type { GroupActivityKind } from '../views/agentPanelView.js';

/** One frame of the strip, on a 16px-tall pixel grid. */
const FRAME_WIDTH = 24;

type Look = { eye?: 'open' | 'happy' | 'closed'; dx?: number; dy?: number; bob?: number };

const EYE_CLASS = { open: undefined, happy: 'pixel-happy', closed: 'pixel-sleeping' };

/** The real Nekko head at half size, its eyes set by the same classes as the mascot's. */
function Head({ eye = 'open', dx = 0, dy = 0, bob = 0 }: Look) {
  return (
    <g className={EYE_CLASS[eye]} transform={`translate(0 ${bob}) scale(.5)`}>
      <PixelHead pupilOffset={{ x: dx, y: dy }} />
    </g>
  );
}

function Box({ x, y, w, h, soft }: { x: number; y: number; w: number; h: number; soft?: boolean }) {
  return <rect className={soft ? 'group-activity-soft' : undefined} x={x} y={y} width={w} height={h} />;
}

/** Draws each `#` as one pixel, with the top left corner at x, y. */
function Bitmap({ rows, x, y, soft }: { rows: string[]; x: number; y: number; soft?: boolean }) {
  const d = rows.flatMap((row, j) => [...row].map((pixel, i) => (pixel === '#' ? `M${x + i} ${y + j}h1v1h-1z` : ''))).join('');
  return <path className={soft ? 'group-activity-soft' : undefined} d={d} />;
}

const TICK = ['...#', '#.#.', '.#..'];
const RING_SMALL = ['.####.', '#....#', '#....#', '#....#', '#....#', '.####.'];
const RING_LARGE = ['..####..', '.#....#.', '#......#', '#......#', '#......#', '#......#', '.#....#.', '..####..'];

function Bricks({ count }: { count: number }) {
  return <>{[0, 1, 2].slice(0, count).map((i) => (
    <React.Fragment key={i}>
      <Box x={17} y={13 - i * 2} w={6} h={1} soft={i % 2 === 0} />
      <Box x={17} y={14 - i * 2} w={6} h={1} soft={i % 2 === 1} />
    </React.Fragment>
  ))}</>;
}

function hammerUp(bricks: number) {
  return <><Head /><Bricks count={bricks} /><Box x={20} y={1} w={4} h={3} /><Box x={21} y={4} w={1} h={4} /></>;
}

function hammerDown(bricks: number) {
  const top = 12 - bricks * 2;
  return <><Head bob={1} /><Bricks count={bricks} /><Box x={17} y={top} w={3} h={3} /><Box x={20} y={top + 1} w={4} h={1} /><Box x={16} y={top + 2} w={1} h={1} soft /><Box x={23} y={top + 2} w={1} h={1} soft /></>;
}

function checklist(ticked: number, dy: number, eye: Look['eye'] = 'open') {
  return <><Head eye={eye} dx={2} dy={dy} />{[3, 7, 11].map((y, i) => (
    <React.Fragment key={y}>
      {i < ticked ? <Bitmap rows={TICK} x={16} y={y} /> : <Box x={17} y={y + 1} w={2} h={1} soft />}
      <Box x={21} y={y + 1} w={3} h={1} soft />
    </React.Fragment>
  ))}</>;
}

function radar(ring: 0 | 1 | 2, look: Look) {
  return <><Head {...look} /><Box x={18} y={7} w={2} h={2} />{ring === 1 && <Bitmap rows={RING_SMALL} x={16} y={5} soft />}{ring === 2 && <Bitmap rows={RING_LARGE} x={15} y={4} soft />}</>;
}

/** `still` is the frame shown when the animation is turned off in Settings. */
const SEQUENCES: Record<GroupActivityKind, { frameMs: number; still: number; frames: React.ReactNode[] }> = {
  building: { frameMs: 170, still: 5, frames: [hammerUp(0), hammerDown(1), hammerUp(1), hammerDown(2), hammerUp(2), hammerDown(3), <><Head eye="happy" /><Bricks count={3} /></>, <><Head eye="happy" /><Bricks count={3} /></>] },
  verifying: { frameMs: 380, still: 3, frames: [checklist(0, -2), checklist(1, -2), checklist(2, 0), checklist(3, 2), checklist(3, 0, 'happy'), checklist(3, 0, 'happy')] },
  watching: { frameMs: 420, still: 0, frames: [radar(0, { dx: 2 }), radar(1, { dx: 2 }), radar(2, { dx: 2 }), radar(0, {}), radar(1, { dx: -2 }), radar(2, { dx: -2 }), radar(0, { eye: 'closed' }), radar(1, {})] },
};

/**
 * A status group's heading while its chats are at it: Nekko building, checking
 * or keeping watch. The frames sit side by side in one strip that steps
 * past a one-frame window, so each heading runs a single compositor animation.
 * Settings > Accessibility turns it off; the system's reduced-motion preference
 * deliberately does not.
 */
export function GroupActivity({ kind, animated = true }: { kind: GroupActivityKind; animated?: boolean }) {
  const { frameMs, still, frames } = SEQUENCES[kind];
  const style = {
    '--group-activity-frames': frames.length,
    '--group-activity-still': still,
    '--group-activity-duration': `${frames.length * frameMs}ms`,
  } as React.CSSProperties;
  return (
    <span className={`group-activity${animated ? '' : ' group-activity-still'}`} style={style} data-group-activity={kind} aria-hidden="true">
      <svg viewBox={`0 0 ${frames.length * FRAME_WIDTH} 16`} width={frames.length * FRAME_WIDTH} height={16} shapeRendering="crispEdges" focusable="false">
        {frames.map((frame, i) => <g key={i} transform={`translate(${i * FRAME_WIDTH} 0)`}>{frame}</g>)}
      </svg>
    </span>
  );
}
