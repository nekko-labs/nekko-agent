/**
 * Long side lists render a page of rows and a "Show more" button, like the file
 * tree: 400 completed chats or models are not 400 rows to mount on every open.
 * The transcript's windowing fits one tall scroller; these lists sit inside
 * other scrollers (the agent panel, the engine page) with groups and expanding
 * rows, so paging is the simpler fit.
 */
export const LIST_PAGE = 50;

/**
 * How many of `total` rows to render: `shown`, stretched to include the row at
 * `keepIndex` (the selected one) so it is never paged out of sight.
 */
export function pagedCount(total: number, shown: number, keepIndex = -1): number {
  return Math.min(total, Math.max(shown, keepIndex + 1));
}

/** Truncates grouped rows to `limit` in total, dropping groups left empty. */
export function pageGroups<K, T>(groups: ReadonlyArray<readonly [K, T[]]>, limit: number): { groups: Array<[K, T[]]>; hidden: number } {
  let left = limit;
  let hidden = 0;
  const out: Array<[K, T[]]> = [];
  for (const [key, rows] of groups) {
    const take = Math.max(0, Math.min(left, rows.length));
    hidden += rows.length - take;
    left -= take;
    if (take > 0) out.push([key, rows.slice(0, take)]);
  }
  return { groups: out, hidden };
}

/** The "Show more" label: the next page, out of everything still hidden. */
export function showMoreLabel(hidden: number, page = LIST_PAGE): string {
  return hidden <= page ? `Show ${hidden.toLocaleString()} more` : `Show ${page.toLocaleString()} more of ${hidden.toLocaleString()}`;
}
