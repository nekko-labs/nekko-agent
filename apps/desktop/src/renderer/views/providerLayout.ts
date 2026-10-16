/**
 * Packs provider groups (local servers, cloud, ...) into grid rows.
 *
 * A group keeps its cards together: full rows of one group come first, in group
 * order. What is left of a group (fewer cards than a row holds) shares a row with
 * the leftovers of other groups when there is room, so the page does not stack a
 * lone card under each heading. A leftover that shares with nobody stays at its
 * group's place.
 */
export interface LayoutSegment<T> {
  group: string;
  items: T[];
}

export type LayoutRow<T> = LayoutSegment<T>[];

export function packGroups<T>(groups: { key: string; items: T[] }[], columns: number): LayoutRow<T>[] {
  const cols = Math.max(1, Math.floor(columns));
  const full = new Map<string, LayoutRow<T>[]>();
  const bins: { used: number; row: LayoutRow<T> }[] = [];
  const binOf = new Map<string, number>();

  for (const g of groups) {
    if (g.items.length === 0) continue;
    const rows: LayoutRow<T>[] = [];
    const whole = Math.floor(g.items.length / cols) * cols;
    for (let i = 0; i < whole; i += cols) rows.push([{ group: g.key, items: g.items.slice(i, i + cols) }]);
    full.set(g.key, rows);
    const rest = g.items.slice(whole);
    if (rest.length === 0) continue;
    let bin = bins.findIndex((b) => b.used + rest.length <= cols);
    if (bin < 0) {
      bins.push({ used: 0, row: [] });
      bin = bins.length - 1;
    }
    bins[bin].used += rest.length;
    bins[bin].row.push({ group: g.key, items: rest });
    binOf.set(g.key, bin);
  }

  const out: LayoutRow<T>[] = [];
  for (const g of groups) {
    out.push(...(full.get(g.key) ?? []));
    const bin = binOf.get(g.key);
    if (bin !== undefined && bins[bin].row.length === 1) out.push(bins[bin].row);
  }
  for (const b of bins) if (b.row.length > 1) out.push(b.row);
  return out;
}

/** How many cards of at least `minWidth` fit across `width` with `gap` between them. */
export function columnsFor(width: number, minWidth: number, gap: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}
