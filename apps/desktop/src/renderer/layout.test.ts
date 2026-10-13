import { describe, it, expect } from 'vitest';
import {
  MAX_ACROSS,
  allPanes,
  canSplit,
  extent,
  isSplit,
  dockPane,
  movePane,
  movePaneToEdge,
  removePane,
  resizeSplit,
  splitPane,
  swapPanes,
  type Direction,
  type WbNode,
  type WbPane,
  type WbSplit,
} from './layout.js';

const pane = (id: string): WbPane => ({ id, kind: 'chat', refId: id });

/** Ids of a split's children, so a shape assertion reads like the screen. */
const kids = (node: WbNode) => (isSplit(node) ? node.children.map((c) => (isSplit(c) ? c.dir : c.id)) : [node.id]);

/** Grow a tree by splitting the same pane over and over. */
function chain(dir: Direction, count: number): WbNode {
  let root: WbNode = pane('a');
  for (let i = 0; i < count; i++) root = splitPane(root, 'a', dir, pane(`p${i}`));
  return root;
}

describe('splitPane', () => {
  it('wraps a lone pane in a split of two', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(isSplit(root) && root.dir).toBe('row');
    expect(kids(root)).toEqual(['a', 'b']);
    expect(isSplit(root) && root.sizes).toEqual([0.5, 0.5]);
  });

  it('puts the new pane on the near side for up and left', () => {
    expect(kids(splitPane(pane('a'), 'a', 'left', pane('b')))).toEqual(['b', 'a']);
    const up = splitPane(pane('a'), 'a', 'up', pane('b'));
    expect(isSplit(up) && up.dir).toBe('col');
    expect(kids(up)).toEqual(['b', 'a']);
  });

  it('joins an existing split on the same axis instead of nesting', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    expect(kids(root)).toEqual(['a', 'b', 'c']);
    expect(isSplit(root) && root.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('nests when the new pane crosses the axis it lands in', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    expect(kids(root)).toEqual(['a', 'col']);
    expect(isSplit(root) && kids(root.children[1])).toEqual(['b', 'c']);
  });

  it('splits a pane nested deep in the tree', () => {
    const nested = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    const root = splitPane(nested, 'c', 'down', pane('d'));
    expect(allPanes(root).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(extent(root)).toEqual({ across: 2, down: 3 });
  });

  it('leaves the tree alone when the target pane is gone', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(splitPane(root, 'nope', 'right', pane('c'))).toEqual(root);
  });
});

describe('extent and the 8×8 ceiling', () => {
  it('counts a row as wide and a column as tall', () => {
    expect(extent(chain('right', 3))).toEqual({ across: 4, down: 1 });
    expect(extent(chain('down', 3))).toEqual({ across: 1, down: 4 });
  });

  it('allows exactly eight across and refuses the ninth', () => {
    const full = chain('right', MAX_ACROSS - 1);
    expect(extent(full).across).toBe(MAX_ACROSS);
    expect(canSplit(full, 'a', 'right')).toBe(false);
    // The other axis is still free: a full row can always grow downwards.
    expect(canSplit(full, 'a', 'down')).toBe(true);
  });

  it('allows exactly eight down and refuses the ninth', () => {
    const full = chain('down', MAX_ACROSS - 1);
    expect(canSplit(full, 'a', 'down')).toBe(false);
    expect(canSplit(full, 'a', 'left')).toBe(true);
  });
});

describe('removePane', () => {
  it('collapses a split left with one child', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(removePane(root, 'b')).toEqual(pane('a'));
  });

  it('keeps the survivors and renormalizes their sizes', () => {
    const root = removePane(splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c')), 'b');
    expect(kids(root!)).toEqual(['a', 'c']);
    expect(isSplit(root!) && root.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it.each(['b', 'd'])('fills a grid vacancy vertically when removing %s', (removed) => {
    const root: WbSplit = {
      id: 'grid', dir: 'col', sizes: [0.4, 0.6], children: [
        { id: 'top', dir: 'row', sizes: [0.3, 0.7], children: [pane('a'), pane('b')] },
        { id: 'bottom', dir: 'row', sizes: [0.3, 0.7], children: [pane('c'), pane('d')] },
      ],
    };
    const next = removePane(root, removed) as WbSplit;
    expect(next.dir).toBe('row');
    expect(next.sizes).toEqual([0.3, 0.7]);
    expect(next.children[1]).toEqual(pane(removed === 'b' ? 'd' : 'b'));
    expect(next.children[0]).toMatchObject({ dir: 'col', sizes: [0.4, 0.6], children: [pane('a'), pane('c')] });
    expect(allPanes(next).map((p) => p.id).sort()).toEqual(['a', 'c', removed === 'b' ? 'd' : 'b'].sort());
    expect(root.children[0]).toMatchObject({ dir: 'row', children: [pane('a'), pane('b')] });
    expect(removePane(next, removed === 'b' ? 'd' : 'b')).toMatchObject({ dir: 'col', sizes: [0.4, 0.6] });
  });

  it('keeps horizontal removal for rows whose dividers are not aligned', () => {
    const root: WbSplit = {
      id: 'grid', dir: 'col', sizes: [0.5, 0.5], children: [
        { id: 'top', dir: 'row', sizes: [0.3, 0.7], children: [pane('a'), pane('b')] },
        { id: 'bottom', dir: 'row', sizes: [0.5, 0.5], children: [pane('c'), pane('d')] },
      ],
    };
    const next = removePane(root, 'b') as WbSplit;
    expect(next.dir).toBe('col');
    expect(next.children[0]).toEqual(pane('a'));
    expect(next.children[1]).toEqual(root.children[1]);
    expect(removePane(root, 'missing')).toEqual(root);
  });

  it('returns null when the last pane goes', () => {
    expect(removePane(pane('a'), 'a')).toBeNull();
  });

  it('unwinds nesting all the way back to a single pane', () => {
    let root: WbNode | null = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    root = removePane(root, 'c');
    root = removePane(root, 'b');
    expect(root).toEqual(pane('a'));
  });
});

describe('movePane', () => {
  it('drags a pane to the other side of the workspace', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    expect(kids(movePane(root, 'c', 'a', 'left')!)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when a pane is dropped on itself', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(movePane(root, 'b', 'b', 'left')).toEqual(root);
  });

  it('leaves the layout alone when lifting the pane collapses the target away', () => {
    // Two panes: removing one leaves the other as the bare root, and dropping
    // beside it would be the same layout with extra churn.
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    const moved = movePane(root, 'b', 'a', 'left');
    expect(allPanes(moved).map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('does not count the dragged pane twice against the ceiling', () => {
    const full = chain('right', MAX_ACROSS - 1);
    const moved = movePane(full, 'p0', 'a', 'left');
    expect(extent(moved).across).toBe(MAX_ACROSS);
  });
});

describe('resizeSplit', () => {
  it('moves one divider and leaves the rest of the split alone', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    const resized = resizeSplit(root, root.id, 0, 0.6) as WbNode;
    const sizes = isSplit(resized) ? resized.sizes : [];
    [0.6, 0.15, 0.25].forEach((want, i) => expect(sizes[i]).toBeCloseTo(want));
  });

  it('stops the divider short of collapsing the pane after it', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    const resized = resizeSplit(root, root.id, 0, 0.95) as WbNode;
    // 'a' grows into 'b' only as far as the minimum allows, and 'c' is untouched.
    expect(isSplit(resized) && resized.sizes[1]).toBeGreaterThan(0.05);
    expect(isSplit(resized) && resized.sizes[2]).toBe(0.25);
  });

  it('never squeezes a pane below its minimum', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    const squeezed = resizeSplit(root, root.id, 0, -5) as WbNode;
    expect(isSplit(squeezed) && squeezed.sizes[0]).toBeGreaterThan(0);
    expect(isSplit(squeezed) && squeezed.sizes[0] + squeezed.sizes[1]).toBeCloseTo(1);
  });

  it('resizes a nested split without touching its parent', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    const inner = isSplit(root) && isSplit(root.children[1]) ? root.children[1] : null;
    const resized = resizeSplit(root, inner!.id, 0, 0.3) as WbNode;
    expect(isSplit(resized) && resized.sizes).toEqual([0.5, 0.5]);
    expect(isSplit(resized) && isSplit(resized.children[1]) && resized.children[1].sizes).toEqual([0.3, 0.7]);
  });
});

describe('swapPanes', () => {
  /** Two windows side by side, the shape a swap is usually asked for in. */
  const pair = (): WbSplit => ({
    id: 's1',
    dir: 'row',
    children: [
      { id: 'a', kind: 'chat', refId: 'chat-1' },
      { id: 'b', kind: 'terminal', refId: 'term-1' },
    ],
    sizes: [0.7, 0.3],
  });

  it('trades what the two windows show, leaving the shape alone', () => {
    const next = swapPanes(pair(), 'a', 'b') as WbSplit;
    expect(next.sizes).toEqual([0.7, 0.3]);
    expect(next.children.map((c) => (c as WbPane).id)).toEqual(['a', 'b']);
    // The slots keep their ids and sizes; only the contents move.
    expect(next.children[0]).toMatchObject({ kind: 'terminal', refId: 'term-1' });
    expect(next.children[1]).toMatchObject({ kind: 'chat', refId: 'chat-1' });
  });

  it('swaps across different branches of the tree', () => {
    const tree: WbSplit = {
      id: 's1',
      dir: 'row',
      children: [
        { id: 'a', kind: 'chat', refId: 'chat-1' },
        { id: 's2', dir: 'col', children: [
          { id: 'b', kind: 'file', refId: '/x.ts' },
          { id: 'c', kind: 'terminal', refId: 'term-1' },
        ], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    };
    const next = swapPanes(tree, 'a', 'c') as WbSplit;
    expect(next.children[0]).toMatchObject({ id: 'a', kind: 'terminal', refId: 'term-1' });
    const nested = next.children[1] as WbSplit;
    expect(nested.children[1]).toMatchObject({ id: 'c', kind: 'chat', refId: 'chat-1' });
  });

  it('leaves the tree alone for a pane that is not there, or for itself', () => {
    const tree = pair();
    expect(swapPanes(tree, 'a', 'a')).toBe(tree);
    expect(swapPanes(tree, 'a', 'nope')).toBe(tree);
    expect(swapPanes(null, 'a', 'b')).toBeNull();
  });

  it('is what the edges could not do: reversing two neighbours', () => {
    // Dropping `a` on `b`'s left edge produces the order it already had, which
    // is the drop that looked like it did nothing.
    const viaEdge = movePane(pair(), 'a', 'b', 'left') as WbSplit;
    expect(viaEdge.children.map((c) => (c as WbPane).refId)).toEqual(['chat-1', 'term-1']);

    const viaSwap = swapPanes(pair(), 'a', 'b') as WbSplit;
    expect(viaSwap.children.map((c) => (c as WbPane).refId)).toEqual(['term-1', 'chat-1']);
  });
});

describe('dragging to an edge of the whole board', () => {
  const stacked = (): WbSplit => ({ id: 's', dir: 'col', children: [pane('a'), pane('b')], sizes: [0.5, 0.5] });
  const columns = (): WbSplit => ({ id: 'r', dir: 'row', children: [pane('a'), pane('b')], sizes: [0.5, 0.5] });

  it('turns two stacked windows into two columns', () => {
    const root = movePaneToEdge(stacked(), 'b', 'right')!;
    expect(isSplit(root) && root.dir).toBe('row');
    expect(kids(root)).toEqual(['a', 'b']);
    expect((root as WbSplit).sizes).toEqual([0.5, 0.5]);
  });

  it('adds a third equal column on the right edge of two columns', () => {
    const root = dockPane(columns(), pane('c'), 'right') as WbSplit;
    expect(kids(root)).toEqual(['a', 'b', 'c']);
    for (const s of root.sizes) expect(s).toBeCloseTo(1 / 3);
  });

  it('puts one wide row under two columns from the bottom edge', () => {
    const root = dockPane(columns(), pane('c'), 'down') as WbSplit;
    expect(root.dir).toBe('col');
    expect(kids(root)).toEqual(['row', 'c']);
    expect(root.sizes).toEqual([0.5, 0.5]);
  });

  it('docks on the left and top edges too', () => {
    expect(kids(dockPane(columns(), pane('c'), 'up'))).toEqual(['c', 'row']);
    const left = dockPane(stacked(), pane('c'), 'left') as WbSplit;
    expect(kids(left)).toEqual(['c', 'col']);
    expect(left.sizes).toEqual([0.5, 0.5]);
  });

  it('leaves a lone window and the 8x8 ceiling alone', () => {
    expect(movePaneToEdge(pane('a'), 'a', 'right')).toEqual(pane('a'));
    const full: WbSplit = { id: 'f', dir: 'row', children: Array.from({ length: MAX_ACROSS }, (_, i) => pane(`p${i}`)), sizes: Array(MAX_ACROSS).fill(1 / MAX_ACROSS) };
    const withExtra: WbSplit = { id: 'c', dir: 'col', children: [full, pane('x')], sizes: [0.5, 0.5] };
    expect(movePaneToEdge(withExtra, 'x', 'right')).toBe(withExtra);
  });
});
