import { describe, expect, it } from 'vitest';
import { allPanes, type WbNode } from './layout.js';
import { HOME, applyWallDrop, heldSize, wallDropTargetAt, type Rect } from './wallDrag.js';

const pane = (id: string) => ({ id, kind: 'chat' as const, refId: id });
/** a | b over the whole 1000×600 stage, 8px gap. */
const rects = new Map<string, Rect>([
  ['a', { x: 0, y: 0, width: 496, height: 600 }],
  ['b', { x: 504, y: 0, width: 496, height: 600 }],
]);
const stage = { width: 1000, height: 600 };
const root: WbNode = { id: 's', dir: 'row', children: [pane('a'), pane('b')], sizes: [0.5, 0.5] };

describe('wallDropTargetAt', () => {
  it('stays home on and just around the held window, so a press moves nothing', () => {
    expect(wallDropTargetAt(rects, 'a', 100, 12, stage, true)).toEqual(HOME);
    expect(wallDropTargetAt(rects, 'a', 100, -10, stage, true)).toEqual(HOME);
    expect(wallDropTargetAt(rects, 'a', 510, 300, stage, true)).toEqual(HOME); // within the home margin
  });

  it('offers the nearest side of the window under the pointer in Dynamic', () => {
    expect(wallDropTargetAt(rects, 'a', 750, 560, stage, true)).toEqual({ kind: 'beside', paneId: 'b', side: 'down' });
    expect(wallDropTargetAt(rects, 'a', 960, 300, stage, true)).toEqual({ kind: 'beside', paneId: 'b', side: 'right' });
  });

  it('fits the row or column at a board edge, from inside or just outside it', () => {
    expect(wallDropTargetAt(rects, 'a', 750, 590, stage, true)).toEqual({ kind: 'beside', paneId: 'b', side: 'down', atEdge: true });
    expect(wallDropTargetAt(rects, 'a', 1010, 300, stage, true)).toEqual({ kind: 'beside', paneId: 'b', side: 'right', atEdge: true });
    // The held zone's own row at that edge is where it already is.
    expect(wallDropTargetAt(rects, 'b', 250, 590, stage, true)).toEqual({ kind: 'beside', paneId: 'a', side: 'down', atEdge: true });
  });

  it('spans the whole side at an edge with Shift held', () => {
    expect(wallDropTargetAt(rects, 'a', 750, 590, stage, true, 8, true)).toEqual({ kind: 'edge', side: 'down' });
    expect(wallDropTargetAt(rects, 'a', 1010, 300, stage, true, 8, true)).toEqual({ kind: 'edge', side: 'right' });
  });

  it('swaps into a slot on the fixed grid, which has no edges to split', () => {
    expect(wallDropTargetAt(rects, 'a', 750, 590, stage, false)).toEqual({ kind: 'swap', paneId: 'b' });
  });

  it('goes home when the pointer is off the board', () => {
    expect(wallDropTargetAt(rects, 'a', 2000, 300, stage, true)).toEqual(HOME);
  });
});

describe('applyWallDrop', () => {
  it('moves, docks and swaps, and leaves the tree alone for home', () => {
    const below = applyWallDrop(root, 'a', { kind: 'beside', paneId: 'b', side: 'down' })!;
    expect(below).toMatchObject({ dir: 'col', children: [{ id: 'b' }, { id: 'a' }] });
    expect(allPanes(applyWallDrop(root, 'a', { kind: 'swap', paneId: 'b' })).map((p) => p.refId)).toEqual(['b', 'a']);
    expect(applyWallDrop(root, 'a', HOME)).toBe(root);
  });
});

describe('heldSize', () => {
  it('keeps the window shape within the held maximum', () => {
    expect(heldSize(1000, 500)).toEqual({ width: 300, height: 150 });
    expect(heldSize(200, 100)).toEqual({ width: 200, height: 100 });
  });
});
