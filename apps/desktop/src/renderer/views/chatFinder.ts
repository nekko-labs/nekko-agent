/**
 * The Agents panel's chat finder: pure helpers, kept out of the component so
 * they test without a DOM.
 *
 * Searching runs over the chat summaries the store already holds (title, first
 * prompt, latest reply), so a search costs a filter over memory and no IPC.
 */
import type { SessionSummary } from '@nekko-agent/shared';

/** Quiet time after the last keystroke before a search runs. Enter skips it. */
export const FINDER_DEBOUNCE_MS = 1500;
/** Most rows the finder draws; enough to scan, few enough to stay instant. */
export const FINDER_LIMIT = 50;

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long ago a chat was touched: days up to 30, then whole months.
 * "Today" for anything under a day, so a fresh chat never reads "0 days".
 */
export function finderAge(then: number, now: number): string {
  const days = Math.max(0, Math.floor((now - then) / DAY));
  if (days < 1) return 'Today';
  if (days <= 30) return days === 1 ? '1 day' : `${days} days`;
  const months = Math.max(1, Math.floor(days / 30));
  return months === 1 ? '1 month' : `${months} months`;
}

export interface FinderHit {
  session: SessionSummary;
  /** A short piece of the prompt or reply that matched, when the title did not. */
  snippet?: string;
}

type Searchable = Pick<SessionSummary, 'id' | 'title' | 'updatedAt' | 'firstUserText' | 'lastReplyText' | 'incognito'>;

const SNIPPET_BEFORE = 24;
const SNIPPET_CHARS = 90;

function snippetAround(text: string, term: string): string | undefined {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return undefined;
  const start = Math.max(0, i - SNIPPET_BEFORE);
  const piece = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + piece + (start + SNIPPET_CHARS < text.length ? '…' : '');
}

/**
 * Chats matching every word of `query`, title matches first, newest first
 * within each. An empty query lists the latest chats. Incognito chats never
 * show: they are not meant to be found again.
 */
export function findChats<T extends Searchable>(sessions: readonly T[], query: string, limit = FINDER_LIMIT): Array<{ session: T; snippet?: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const live = sessions.filter((s) => !s.incognito);
  const byRecent = (a: T, b: T) => b.updatedAt - a.updatedAt;
  if (!terms.length) return [...live].sort(byRecent).slice(0, limit).map((session) => ({ session }));
  const inTitle: T[] = [];
  const inBody: Array<{ session: T; snippet?: string }> = [];
  for (const s of live) {
    const title = (s.title || '').toLowerCase();
    const body = `${s.firstUserText ?? ''}\n${s.lastReplyText ?? ''}`;
    const hay = `${title}\n${body.toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    if (terms.every((t) => title.includes(t))) inTitle.push(s);
    else inBody.push({ session: s, snippet: snippetAround(body, terms.find((t) => !title.includes(t)) ?? terms[0]) });
  }
  inTitle.sort(byRecent);
  inBody.sort((a, b) => byRecent(a.session, b.session));
  return [...inTitle.map((session) => ({ session })), ...inBody].slice(0, limit);
}
