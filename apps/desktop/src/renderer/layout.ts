/**
 * The window layout inside one workspace: a tree of splits, not a tab strip.
 *
 * Tabs made every extra window cost you the one you were already looking at —
 * open a file out of a chat and the chat went behind it. Here a workspace holds
 * a binary-ish tree of rows and columns, every leaf visible at once, and you add
 * a window by saying which side of an existing one it goes on. The tree is the
 * whole model: splitting, closing, dragging a window somewhere else and dragging
 * a divider are all rewrites of it, and every function here is pure so the store
 * can swap one tree for the next.
 */

/** Which side of a pane a new window lands on. */
export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Where a dragged window is being offered: an edge to split along, or the
 * middle, which trades the two windows' places instead of making a new one.
 *
 * Swapping needs its own target because the edges cannot express it. Dropping a
 * window on the left edge of the neighbour already to its right produces the
 * order it was already in, so the gesture people reach for ("put these two the
 * other way round") looked like a drop that did nothing.
 */
export type DropTarget = Direction | 'swap';

/**
 * What a single window shows. The last two exist only on the Agent board
 * wall, where the automations list and the insights box are windows you place
 * like any other.
 */
export type PaneKind = 'chat' | 'terminal' | 'file' | 'files' | 'browser' | 'diff' | 'pr' | 'hypergate' | 'automations' | 'insights' | 'subscriptions' | 'resources' | 'zone';

/** A leaf: one window. */
export interface WbPane {
  id: string;
  kind: PaneKind;
  /**
   * What the pane points at: sessionId (chat/diff), terminalId (terminal),
   * absolute file path (file), folder path (files), URL (browser), PR URL (pr),
   * or the Hypergate manager's URL (hypergate).
   */
  refId: string;
  /** Agent board only: preserve this window when adding or arranging. */
  pinned?: boolean;
  /**
   * Agent board only: the name of the zone this leaf is. A zone outlives the
   * agent in it; an empty one is kind `zone` with no refId.
   */
  zone?: string;
  /** Agent board only: the zone's colour, an index into the zone tints. */
  tint?: number;
}

/**
 * A branch: children laid out along one axis, `row` side by side and `col`
 * stacked. `sizes` runs parallel to `children` and sums to 1.
 */
export interface WbSplit {
  id: string;
  dir: 'row' | 'col';
  children: WbNode[];
  sizes: number[];
}

export type WbNode = WbPane | WbSplit;

/** How many windows may sit across one axis of a workspace. */
export const MAX_ACROSS = 8;

/** The smallest share of its split a window can be dragged down to. */
const MIN_FRACTION = 0.08;

export function isSplit(node: WbNode): node is WbSplit {
  return (node as WbSplit).children !== undefined;
}

const axisOf = (dir: Direction): WbSplit['dir'] => (dir === 'left' || dir === 'right' ? 'row' : 'col');
const isBefore = (dir: Direction) => dir === 'left' || dir === 'up';

let seq = 0;
export const newPaneId = () => `pane_${(++seq).toString(36)}`;
export const newSplitId = () => `split_${(++seq).toString(36)}`;
/** Move the id counter past `n`, so ids restored from a saved layout are never minted again. */
export function reserveIdSeq(n: number): void {
  seq = Math.max(seq, n);
}

/** Every window in the tree, left to right and top to bottom. */
export function allPanes(node: WbNode | null): WbPane[] {
  if (!node) return [];
  return isSplit(node) ? node.children.flatMap(allPanes) : [node];
}

/** The window with this id, or null. */
export function findPane(node: WbNode | null, paneId: string): WbPane | null {
  return allPanes(node).find((p) => p.id === paneId) ?? null;
}

/** The first window pointing at this thing, whatever workspace shape it sits in. */
export function findPaneByRef(node: WbNode | null, kind: PaneKind, refId: string): WbPane | null {
  return allPanes(node).find((p) => p.kind === kind && p.refId === refId) ?? null;
}

/** Point an existing window at something else, in place. */
export function retargetPane(node: WbNode | null, paneId: string, refId: string): WbNode | null {
  if (!node) return null;
  if (!isSplit(node)) return node.id === paneId ? { ...node, refId } : node;
  return { ...node, children: node.children.map((c) => retargetPane(c, paneId, refId) as WbNode) };
}

/**
 * The widest row and tallest column the tree produces: the numbers the 8×8
 * ceiling is about. A row's width is its children's widths added up and its
 * height is the tallest of them; a column is the other way around.
 */
export function extent(node: WbNode | null): { across: number; down: number } {
  if (!node) return { across: 0, down: 0 };
  if (!isSplit(node)) return { across: 1, down: 1 };
  const kids = node.children.map(extent);
  return node.dir === 'row'
    ? { across: sum(kids.map((k) => k.across)), down: Math.max(...kids.map((k) => k.down)) }
    : { across: Math.max(...kids.map((k) => k.across)), down: sum(kids.map((k) => k.down)) };
}

/**
 * Would splitting this window that way stay inside the 8×8 ceiling? Answered by
 * doing the split and measuring the result rather than by reasoning about the
 * tree in place, because a split beside a sibling of the same axis widens the
 * workspace while one across it does not, and the tree is small enough that
 * building a throwaway is cheaper than getting that case subtly wrong.
 */
export function canSplit(root: WbNode | null, paneId: string, dir: Direction): boolean {
  if (!root) return true;
  const probe: WbPane = { id: '__probe', kind: 'chat', refId: '' };
  const { across, down } = extent(splitPane(root, paneId, dir, probe));
  return across <= MAX_ACROSS && down <= MAX_ACROSS;
}

/**
 * Put `pane` on the given side of `paneId`.
 *
 * Landing next to a sibling on the same axis joins that split instead of
 * nesting a new one inside it, so three windows in a row stay one row of three
 * — the shape you'd draw if asked — rather than a row containing a row. The new
 * window takes half of what its neighbour had, leaving everything else alone.
 */
export function splitPane(root: WbNode | null, paneId: string, dir: Direction, pane: WbPane): WbNode {
  if (!root) return pane;
  const axis = axisOf(dir);
  const before = isBefore(dir);

  // The target is the whole workspace: wrap it in a split of two.
  if (!isSplit(root)) {
    if (root.id !== paneId) return root;
    return { id: newSplitId(), dir: axis, children: order(root, pane, before), sizes: [0.5, 0.5] };
  }

  const at = root.children.findIndex((c) => !isSplit(c) && c.id === paneId);
  if (at >= 0) {
    // A child of a split on the same axis becomes a sibling; on the other axis
    // it grows a nested split of its own.
    if (root.dir === axis) {
      const children = [...root.children];
      const sizes = [...root.sizes];
      const half = sizes[at] / 2;
      sizes[at] = half;
      children.splice(before ? at : at + 1, 0, pane);
      sizes.splice(before ? at : at + 1, 0, half);
      return { ...root, children, sizes };
    }
    const nested: WbSplit = {
      id: newSplitId(),
      dir: axis,
      children: order(root.children[at], pane, before),
      sizes: [0.5, 0.5],
    };
    return { ...root, children: root.children.map((c, i) => (i === at ? nested : c)) };
  }

  return { ...root, children: root.children.map((c) => splitPane(c, paneId, dir, pane)) };
}

/**
 * Take a window out. A split left holding one child collapses into that child,
 * so closing windows unwinds the nesting that opening them built up; the
 * survivors keep their relative sizes.
 */
export function removePane(root: WbNode | null, paneId: string): WbNode | null {
  if (!root) return null;
  if (!isSplit(root)) return root.id === paneId ? null : root;

  // A tiled grid is stored as rows, but a vacancy should grow its vertical
  // neighbour rather than stretch the remaining row horizontally. Rewrite only
  // aligned, leaf-only rows into columns, preserving every existing rectangle.
  if (root.dir === 'col' && root.children.length > 1) {
    const rows = root.children;
    const first = rows[0];
    if (isSplit(first) && first.dir === 'row' && rows.every((row) =>
      isSplit(row) && row.dir === 'row' && row.children.length === first.children.length
      && row.children.every((child) => !isSplit(child))
      && row.sizes.every((size, i) => Math.abs(size - first.sizes[i]) < 1e-9),
    ) && rows.some((row) => isSplit(row) && row.children.some((child) => child.id === paneId))) {
      const columns: WbSplit[] = first.children.map((_, i) => ({
        id: newSplitId(), dir: 'col',
        children: rows.map((row) => (row as WbSplit).children[i]),
        sizes: [...root.sizes],
      }));
      return removePane({ ...root, dir: 'row', children: columns, sizes: [...first.sizes] }, paneId);
    }
  }

  const children: WbNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const kept = removePane(child, paneId);
    if (kept) {
      children.push(kept);
      sizes.push(root.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...root, children, sizes: normalize(sizes) };
}

/**
 * Drag a window onto a side of another one. The pane is lifted out first, so a
 * move within the same split doesn't briefly count twice against the ceiling
 * and the sizes it vacates go back to its old neighbours.
 */
export function movePane(root: WbNode | null, paneId: string, targetPaneId: string, dir: Direction): WbNode | null {
  if (!root || paneId === targetPaneId) return root;
  const pane = findPane(root, paneId);
  if (!pane) return root;
  const without = removePane(root, paneId);
  // The target went with it (it was the pane's only sibling and the split
  // collapsed): nothing sensible to drop onto, so leave the layout alone.
  if (!without || !findPane(without, targetPaneId)) return root;
  return splitPane(without, targetPaneId, dir, pane);
}

/**
 * Put `pane` along one whole side of the workspace rather than beside one
 * window: dropped on the board's right edge it becomes a full-height column,
 * on the bottom edge a full-width row.
 *
 * A root already split along that axis takes it as one more equal sibling (a
 * row of two becomes a row of three, each a third), so docking again keeps
 * adding columns. Any other root is wrapped, and the new window gets one
 * share of however many the root spans that way: half beside a single
 * column, a third beside two.
 */
export function dockPane(root: WbNode | null, pane: WbPane, side: Direction): WbNode {
  if (!root) return pane;
  const axis = axisOf(side);
  const before = isBefore(side);
  if (isSplit(root) && root.dir === axis) {
    const n = root.children.length;
    const sizes = root.sizes.map((s) => (s * n) / (n + 1));
    return {
      ...root,
      children: before ? [pane, ...root.children] : [...root.children, pane],
      sizes: before ? [1 / (n + 1), ...sizes] : [...sizes, 1 / (n + 1)],
    };
  }
  const { across, down } = extent(root);
  const share = 1 / ((axis === 'row' ? across : down) + 1);
  return { id: newSplitId(), dir: axis, children: order(root, pane, before), sizes: before ? [share, 1 - share] : [1 - share, share] };
}

/**
 * Drag a window to one side of the whole workspace. Lifted out first, like
 * `movePane`; unchanged when it is the only window or the move would break
 * the 8×8 ceiling.
 */
export function movePaneToEdge(root: WbNode | null, paneId: string, side: Direction): WbNode | null {
  if (!root) return root;
  const pane = findPane(root, paneId);
  if (!pane) return root;
  const without = removePane(root, paneId);
  if (!without) return root;
  const next = dockPane(without, pane, side);
  const { across, down } = extent(next);
  return across <= MAX_ACROSS && down <= MAX_ACROSS ? next : root;
}

/**
 * Trade two windows' places, leaving the shape of the workspace alone.
 *
 * Every other move rewrites the tree; this one rewrites two leaves and nothing
 * else, so both windows keep the size and position their slot had. That is the
 * point: a swap is the one rearrangement where the user is telling you the
 * layout is already right and only the contents are in the wrong order.
 */
export function swapPanes(root: WbNode | null, aId: string, bId: string): WbNode | null {
  if (!root || aId === bId) return root;
  const a = findPane(root, aId);
  const b = findPane(root, bId);
  if (!a || !b) return root;

  const swap = (node: WbNode): WbNode => {
    if (isSplit(node)) return { ...node, children: node.children.map(swap) };
    // The ids travel with their slots, so anything holding a pane id (the active
    // pane, a drag in flight) keeps pointing at the window the user is looking at
    // rather than at whatever moved into its place.
    if (node.id === aId) return { ...node, kind: b.kind, refId: b.refId };
    if (node.id === bId) return { ...node, kind: a.kind, refId: a.refId };
    return node;
  };
  return swap(root);
}

/**
 * Move the divider between `children[index]` and the one after it. `fraction`
 * is the share of the split the left/top side should take, counted from the
 * start of the split — what a pointer position converts to directly.
 */
export function resizeSplit(root: WbNode | null, splitId: string, index: number, fraction: number): WbNode | null {
  if (!root || !isSplit(root)) return root;
  if (root.id !== splitId) {
    return { ...root, children: root.children.map((c) => resizeSplit(c, splitId, index, fraction) ?? c) };
  }
  if (root.sizes[index] == null || root.sizes[index + 1] == null) return root;
  const leading = sum(root.sizes.slice(0, index));
  const pair = root.sizes[index] + root.sizes[index + 1];
  const first = clamp(fraction - leading, MIN_FRACTION, pair - MIN_FRACTION);
  const sizes = [...root.sizes];
  sizes[index] = first;
  sizes[index + 1] = pair - first;
  return { ...root, sizes };
}

function order(existing: WbNode, added: WbNode, before: boolean): WbNode[] {
  return before ? [added, existing] : [existing, added];
}

function normalize(sizes: number[]): number[] {
  const total = sum(sizes);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
