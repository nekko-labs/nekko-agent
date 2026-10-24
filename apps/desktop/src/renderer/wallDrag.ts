/**
 * Picking a window up off the Agent board and putting it down somewhere else.
 *
 * The board answers "where would this land?" with the real result: while a
 * window is held, the wall lays itself out as if it had already been dropped,
 * so the other windows step aside and the held window's own box (drawn as a
 * dotted landing zone) sits where it will end up. These are the pure parts:
 * what is under the pointer, and what dropping there does to the tree.
 */
import { movePane, movePaneToEdge, swapPanes, type Direction, type WbNode } from './layout.js';

export interface Rect { x: number; y: number; width: number; height: number }

/** Where a held window would go: back where it was, beside a window, along a board edge, or into a window's slot. */
export type WallDropTarget =
  | { kind: 'home' }
  | { kind: 'beside'; paneId: string; side: Direction }
  | { kind: 'edge'; side: Direction }
  | { kind: 'swap'; paneId: string };

export const HOME: WallDropTarget = { kind: 'home' };

/**
 * How far around its own spot the pointer can stray before anything moves.
 * A press on the title strip is a few pixels from the window's top edge, so
 * without it the first wobble upward already counted as a move.
 */
export const HOME_MARGIN = 24;
/** The band along each side of the board (inside and just outside it) that docks a window to that whole side. */
export const EDGE_BAND = 16;
/** The held card is at most this size; the landing zone shows the real one. */
export const HELD_MAX = { width: 300, height: 200 };

const inside = (r: Rect, x: number, y: number, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad;

/**
 * What is under the pointer, in stage coordinates.
 *
 * `rects` is the layout as it was at pick-up and never the previewed one: a
 * zone opening would otherwise move the window under the pointer and the
 * target would flip back and forth. `grid` is the Dynamic layout, where a drop
 * splits beside a window; the fixed grid only has slots, so there it swaps.
 */
export function wallDropTargetAt(
  rects: ReadonlyMap<string, Rect>,
  held: string,
  x: number,
  y: number,
  stage: { width: number; height: number },
  grid: boolean,
  gap = 8,
): WallDropTarget {
  const home = rects.get(held);
  if (home && inside(home, x, y, HOME_MARGIN)) return HOME;
  if (grid && rects.size > 1) {
    const toEdge: Array<[Direction, number]> = [['left', x], ['right', stage.width - x], ['up', y], ['down', stage.height - y]];
    const [side, distance] = toEdge.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (Math.abs(distance) <= EDGE_BAND) return { kind: 'edge', side };
  }
  for (const [id, r] of rects) {
    // Each window owns half the gutter on every side, so a seam is never dead space.
    if (id === held || !inside(r, x, y, gap / 2)) continue;
    if (!grid) return { kind: 'swap', paneId: id };
    const d: Array<[Direction, number]> = [
      ['left', (x - r.x) / (r.width || 1)], ['right', (r.x + r.width - x) / (r.width || 1)],
      ['up', (y - r.y) / (r.height || 1)], ['down', (r.y + r.height - y) / (r.height || 1)],
    ];
    return { kind: 'beside', paneId: id, side: d.reduce((a, b) => (b[1] < a[1] ? b : a))[0] };
  }
  return HOME;
}

/** The tree after dropping `held` on `target`; the same tree when the drop changes nothing. */
export function applyWallDrop(root: WbNode | null, held: string, target: WallDropTarget): WbNode | null {
  if (target.kind === 'beside') return movePane(root, held, target.paneId, target.side);
  if (target.kind === 'edge') return movePaneToEdge(root, held, target.side);
  if (target.kind === 'swap') return swapPanes(root, held, target.paneId);
  return root;
}

export const sameTarget = (a: WallDropTarget, b: WallDropTarget) =>
  a.kind === b.kind && ('paneId' in a ? a.paneId : '') === ('paneId' in b ? b.paneId : '') && ('side' in a ? a.side : '') === ('side' in b ? b.side : '');

/** The held card keeps the window's shape at no more than `HELD_MAX`. */
export function heldSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, HELD_MAX.width / (width || 1), HELD_MAX.height / (height || 1));
  return { width: width * k, height: height * k };
}
