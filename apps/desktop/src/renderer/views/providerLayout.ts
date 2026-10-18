/**
 * Packs provider groups (local servers, cloud, ...) into grid rows.
 *
 * Each group is drawn as one bordered container, so a group is never split: all
 * of its cards stay in its container and wrap inside it. Groups that fit on one
 * line together share it, in group order; a group with more cards than a line
 * holds takes the full width and wraps.
 */
export interface LayoutSegment<T> {
  group: string;
  items: T[];
  /** Grid columns the group's container spans (and lays its cards out in). */
  span: number;
}

export type LayoutRow<T> = LayoutSegment<T>[];

export function packGroups<T>(groups: { key: string; items: T[] }[], columns: number): LayoutRow<T>[] {
  const cols = Math.max(1, Math.floor(columns));
  const out: LayoutRow<T>[] = [];
  let used = cols;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    const span = Math.min(g.items.length, cols);
    if (used + span > cols) {
      out.push([]);
      used = 0;
    }
    out[out.length - 1].push({ group: g.key, items: g.items, span });
    used += span;
  }
  return out;
}

/** How many cards of at least `minWidth` fit across `width` with `gap` between them. */
export function columnsFor(width: number, minWidth: number, gap: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}
