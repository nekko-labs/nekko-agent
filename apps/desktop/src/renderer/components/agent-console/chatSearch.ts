/**
 * Find-in-chat, the parts that need no DOM: what text a transcript row shows,
 * where a query matches in it, and how the matches are ordered and stepped
 * through.
 *
 * A match is the whole word (or phrase), ignoring case: "scroll" finds
 * "Scroll" and "SCROLL" but not "scroller" or "autoscroll". Word characters are
 * letters and digits in any script, plus underscore, so the rule holds for
 * accented and non-Latin text too.
 *
 * The transcript is windowed (only rows near the viewport are in the DOM), so
 * the count comes from the messages themselves rather than from the page. The
 * page is then searched with the same rule, one text node at a time, to draw
 * the highlights on whatever is rendered.
 */
import type { TranscriptRow } from './transcript.js';

/** One occurrence: which row it is in, and which occurrence within that row. */
export interface ChatMatch {
  rowKey: string;
  /** 0-based occurrence within the row, in reading order. */
  nth: number;
}

const WORD = String.raw`[\p{L}\p{N}_]`;

/**
 * The pattern for a query, or null when there is nothing to search for.
 * Whitespace inside a phrase matches any run of whitespace.
 */
export function searchPattern(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const body = q.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(String.raw`\s+`);
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, 'giu');
}

/** Every [start, end) where the pattern matches in `text`. */
export function matchRanges(text: string, pattern: RegExp): Array<[number, number]> {
  const re = new RegExp(pattern.source, pattern.flags);
  const out: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * The text a row shows as message text, as close to what renders as the
 * markdown source allows: link and image targets are not shown, so they are
 * not searched. Tool steps, reasoning, stats and PR cards are not message text.
 */
export function rowSearchText(row: TranscriptRow): string {
  if (row.kind !== 'msg') return '';
  const m = row.message;
  if (m.role !== 'user' && m.role !== 'assistant') return '';
  const text = m.role === 'user' && m.skill ? m.skill.input : m.content;
  return (text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\]\([^)]*\)/g, ']');
}

/** Every match in the transcript, top to bottom. */
export function findChatMatches(rows: readonly TranscriptRow[], query: string): ChatMatch[] {
  const pattern = searchPattern(query);
  if (!pattern) return [];
  const out: ChatMatch[] = [];
  for (const row of rows) {
    const n = matchRanges(rowSearchText(row), pattern).length;
    for (let i = 0; i < n; i++) out.push({ rowKey: row.key, nth: i });
  }
  return out;
}

/** The next index going down (+1) or up (-1), wrapping around the ends. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/**
 * Where to start when a query is typed: the first match in a row that is on
 * screen, so the search begins where the reader is; otherwise the latest one.
 */
export function startMatch(matches: readonly ChatMatch[], visibleRowKeys: ReadonlySet<string>): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => visibleRowKeys.has(m.rowKey));
  return i >= 0 ? i : matches.length - 1;
}
