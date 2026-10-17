/**
 * The Agents panel's chat finder: pure helpers, kept out of the component so
 * they test without a DOM.
 *
 * Two layers feed a search. The chat summaries the store already holds (title,
 * first prompt, latest reply) answer at once with no IPC. The transcript index
 * (`chatFinderIndex.ts`) adds every user and assistant message and every
 * artifact a chat produced, loaded once per chat version. Matching is exact,
 * case-insensitive substring matching on every word in both layers; nothing is
 * sampled or ranked away, results are only capped for drawing.
 */
import type { ProviderConfig, SessionSummary } from '@nekko-agent/shared';
import { isLocalProvider } from '@nekko-agent/shared';
import type { ArtifactEntry } from '../artifactsIndex.js';
import { matchRanges, searchPattern } from '../components/agent-console/chatSearch.js';

/** Quiet time after the last keystroke before a search runs. Enter skips it. */
export const FINDER_DEBOUNCE_MS = 1000;
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

/** What the finder searches, one tab each. */
export type FinderScope = 'all' | 'chats' | 'messages' | 'artifacts' | 'groups' | 'providers';

export const FINDER_SCOPES: ReadonlyArray<{ id: FinderScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chats', label: 'Chats' },
  { id: 'messages', label: 'Messages' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'groups', label: 'Groups' },
  { id: 'providers', label: 'Providers' },
];

/** Scopes whose results need transcripts, not just summaries. */
export const needsTranscripts = (scope: FinderScope, query: string): boolean =>
  scope === 'artifacts' || (scope !== 'chats' && query.trim().length > 0);

/** An inclusive range of whole local days, as epoch ms (start of `from`'s day to end of `to`'s day). */
export interface DateRange { from: number; to: number }

export const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const endOfDay = (t: number): number => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };

/** A range covering the two picked days, in either order. */
export function dayRange(a: number, b: number): DateRange {
  return { from: startOfDay(Math.min(a, b)), to: endOfDay(Math.max(a, b)) };
}

export const inRange = (at: number, range?: DateRange | null): boolean => !range || (at >= range.from && at <= range.to);

/** A chat counts for a date range when it was active in it: started before the range ended, touched after it began. */
export const chatInRange = (s: Pick<SessionSummary, 'createdAt' | 'updatedAt'>, range?: DateRange | null): boolean =>
  !range || ((s.createdAt ?? s.updatedAt) <= range.to && s.updatedAt >= range.from);

/** One message of a transcript as the index keeps it: text only, no images or tool output. */
export interface IndexedMessage { id: string; role: 'user' | 'assistant'; at: number; text: string; lower: string }

/** Everything searchable in one chat beyond its summary. Valid while `updatedAt` matches. */
export interface IndexedChat { updatedAt: number; messages: IndexedMessage[]; artifacts: ArtifactEntry[] }

export type ChatIndex = ReadonlyMap<string, IndexedChat>;

export const finderTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

const SNIPPET_BEFORE = 24;
const SNIPPET_CHARS = 90;

export function snippetAround(text: string, term: string): string | undefined {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return undefined;
  const start = Math.max(0, i - SNIPPET_BEFORE);
  const piece = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + piece + (start + SNIPPET_CHARS < text.length ? '…' : '');
}

/** Where a chat matched, strongest first. */
export type MatchKind = 'title' | 'description' | 'message' | 'artifact';
const KIND_RANK: Record<MatchKind, number> = { title: 0, description: 1, message: 2, artifact: 3 };

export interface FinderHit<T = SessionSummary> {
  session: T;
  /** Absent when the query is empty (a plain latest list). */
  kind?: MatchKind;
  /** A short piece of whatever matched, when the title alone did not. */
  snippet?: string;
  /** Messages (inside the date range) that contain a search word. */
  messageCount?: number;
  /** The message the snippet came from. */
  messageId?: string;
  /**
   * What Find in this chat should open with so the reader lands on the match:
   * a search word that appears as a whole word in that message. Absent when
   * the words only appear inside longer words, which Find in chat skips.
   */
  findText?: string;
}

/** The longest search word Find in chat (whole words only) would find in `text`. */
export function findTextFor(text: string, terms: readonly string[]): string | undefined {
  return [...terms].sort((a, b) => b.length - a.length).find((t) => {
    const p = searchPattern(t);
    return !!p && matchRanges(text, p).length > 0;
  });
}

type Searchable = Pick<SessionSummary, 'id' | 'title' | 'updatedAt' | 'firstUserText' | 'lastReplyText' | 'incognito'> & { createdAt?: number };

const descriptionOf = (s: Searchable) => `${s.firstUserText ?? ''}\n${s.lastReplyText ?? ''}`;
const artifactText = (a: ArtifactEntry) => `${a.title}\n${a.filename}\n${a.path}`.toLowerCase();

/**
 * How one chat matches `terms`, or null. Every word has to appear somewhere in
 * the chat (title, description, messages inside the range, artifact names); the
 * kind says the strongest place they all appear. Without index data only the
 * summary is searched, so a chat can move from no match to a match as its
 * transcript arrives, never the other way.
 */
export function matchChat<T extends Searchable>(s: T, terms: readonly string[], indexed?: IndexedChat, range?: DateRange | null, sources: { messages: boolean; artifacts: boolean } = { messages: true, artifacts: true }): FinderHit<T> | null {
  const title = (s.title || '').toLowerCase();
  const description = descriptionOf(s);
  const head = `${title}\n${description.toLowerCase()}`;
  if (terms.every((t) => title.includes(t))) return { session: s, kind: 'title' };
  if (terms.every((t) => head.includes(t))) {
    return { session: s, kind: 'description', snippet: snippetAround(description, terms.find((t) => !title.includes(t)) ?? terms[0]) };
  }
  if (!indexed) return null;
  const messages = sources.messages ? indexed.messages.filter((m) => inRange(m.at, range)) : [];
  const missing = (hay: string) => terms.filter((t) => !hay.includes(t));
  const afterHead = missing(head);
  if (messages.length) {
    const left = afterHead.filter((t) => !messages.some((m) => m.lower.includes(t)));
    if (left.length === 0) {
      const hits = messages.filter((m) => terms.some((t) => m.lower.includes(t)));
      const best = bestMessage(messages, afterHead)!;
      return withFind({ session: s, kind: 'message', snippet: snippetAround(best.text, afterHead.find((t) => best.lower.includes(t)) ?? afterHead[0]), messageCount: hits.length, messageId: best.id }, best.text, terms);
    }
  }
  if (sources.artifacts) {
    const artifacts = indexed.artifacts.filter((a) => inRange(a.at, range));
    const all = `${head}\n${messages.map((m) => m.lower).join('\n')}\n${artifacts.map(artifactText).join('\n')}`;
    if (artifacts.length && missing(all).length === 0) {
      const a = artifacts.find((x) => afterHead.some((t) => artifactText(x).includes(t))) ?? artifacts[0];
      return { session: s, kind: 'artifact', snippet: `${a.title} · ${a.filename}` };
    }
  }
  return null;
}

const byRecent = (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt;

/** The rows to draw (capped) and how many matched in all. */
export interface SearchResult<R> { hits: R[]; total: number }

/**
 * Chats for the chat-level scopes. `chats` searches titles and descriptions,
 * `messages` the full transcript, `all` every source. An empty query lists the
 * latest chats (inside the range). Incognito chats never show: they are not
 * meant to be found again. `total` counts every match before the draw cap.
 */
export function searchChats<T extends Searchable>(sessions: readonly T[], query: string, opts: { scope?: 'all' | 'chats' | 'messages'; index?: ChatIndex; range?: DateRange | null; limit?: number } = {}): SearchResult<FinderHit<T>> {
  const { scope = 'chats', index, range, limit = FINDER_LIMIT } = opts;
  const terms = finderTerms(query);
  const live = sessions.filter((s) => !s.incognito && chatInRange({ createdAt: s.createdAt ?? s.updatedAt, updatedAt: s.updatedAt }, range));
  if (!terms.length) {
    const hits = [...live].sort(byRecent).map((session) => ({ session }));
    return { hits: hits.slice(0, limit), total: hits.length };
  }
  const hits: Array<FinderHit<T>> = [];
  for (const s of live) {
    let hit: FinderHit<T> | null;
    if (scope === 'chats') hit = matchChat(s, terms, undefined, range);
    else if (scope === 'messages') hit = messageMatch(s, terms, index?.get(s.id), range);
    else hit = matchChat(s, terms, index?.get(s.id), range);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => KIND_RANK[a.kind!] - KIND_RANK[b.kind!] || byRecent(a.session, b.session));
  return { hits: hits.slice(0, limit), total: hits.length };
}

/** Only the transcript: every word inside the chat's messages (in range), not its title. */
function messageMatch<T extends Searchable>(s: T, terms: readonly string[], indexed: IndexedChat | undefined, range?: DateRange | null): FinderHit<T> | null {
  if (!indexed) return null;
  const messages = indexed.messages.filter((m) => inRange(m.at, range));
  if (!terms.every((t) => messages.some((m) => m.lower.includes(t)))) return null;
  const hits = messages.filter((m) => terms.some((t) => m.lower.includes(t)));
  const best = bestMessage(messages, terms)!;
  return withFind({ session: s, kind: 'message', snippet: snippetAround(best.text, terms.find((t) => best.lower.includes(t)) ?? terms[0]), messageCount: hits.length, messageId: best.id }, best.text, terms);
}

/**
 * The message a hit lands on: one holding every word, else any holding one;
 * within that, the first where Find in chat (whole words) can find a word, so
 * opening the chat lands on a highlighted match.
 */
function bestMessage(messages: readonly IndexedMessage[], terms: readonly string[]): IndexedMessage | undefined {
  const all = messages.filter((m) => terms.every((t) => m.lower.includes(t)));
  const pool = all.length ? all : messages.filter((m) => terms.some((t) => m.lower.includes(t)));
  return pool.find((m) => findTextFor(m.text, terms)) ?? pool[0];
}

function withFind<T>(hit: FinderHit<T>, text: string, terms: readonly string[]): FinderHit<T> {
  const findText = findTextFor(text, terms);
  return findText ? { ...hit, findText } : hit;
}

/** Back-compat: the summary-only search the finder started with. */
export function findChats<T extends Searchable>(sessions: readonly T[], query: string, limit = FINDER_LIMIT): Array<FinderHit<T>> {
  return searchChats(sessions, query, { scope: 'chats', limit }).hits.map(({ session, snippet }) => (snippet ? { session, snippet } : { session }));
}

/**
 * Artifacts across chats: every word in the artifact's title, file name, path
 * or chat title. One row per path (the newest chat that touched it owns it),
 * newest first. An empty query lists the latest artifacts.
 */
export function searchArtifacts(sessions: readonly Searchable[], index: ChatIndex, query: string, opts: { range?: DateRange | null; limit?: number } = {}): SearchResult<ArtifactEntry> {
  const { range, limit = FINDER_LIMIT } = opts;
  const terms = finderTerms(query);
  // One owner per path first (the newest chat that touched it, within the
  // range), then filter, so an older chat's title never matches a file it
  // no longer owns.
  const byPath = new Map<string, ArtifactEntry>();
  for (const s of sessions) {
    if (s.incognito) continue;
    for (const a of index.get(s.id)?.artifacts ?? []) {
      if (!inRange(a.at, range)) continue;
      const key = a.path.toLowerCase();
      const prev = byPath.get(key);
      if (!prev || a.at > prev.at) byPath.set(key, { ...a, sessionTitle: s.title || a.sessionTitle });
    }
  }
  const all = [...byPath.values()]
    .filter((a) => { const hay = `${artifactText(a)}\n${a.sessionTitle.toLowerCase()}`; return terms.every((t) => hay.includes(t)); })
    .sort((a, b) => b.at - a.at);
  return { hits: all.slice(0, limit), total: all.length };
}

// --- Groups and providers: facets that drill into their chats -------------

export interface Facet { key: string; name: string; section?: string }
export interface FacetResult<T> extends Facet { sessions: T[] }

/** The Agents panel's grouping: a chat's project folder when it still exists, else General. */
export function chatGroupKey(s: Pick<SessionSummary, 'workspaceId'>, workspaces: ReadonlyArray<{ id: string }>): string {
  return s.workspaceId && workspaces.some((w) => w.id === s.workspaceId) ? s.workspaceId : '__none';
}

export function groupFacets(workspaces: ReadonlyArray<{ id: string; name: string }>): Facet[] {
  return [{ key: '__none', name: 'General' }, ...workspaces.map((w) => ({ key: w.id, name: w.name }))];
}

export type ProviderClass = 'local' | 'cloud' | 'other';
export const PROVIDER_SECTIONS: ReadonlyArray<{ id: ProviderClass; label: string }> = [
  { id: 'local', label: 'Local models' },
  { id: 'cloud', label: 'Cloud models' },
  { id: 'other', label: 'Other' },
];

const LOOPBACK = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

/** On-device servers are local; an OpenAI-compatible endpoint is local only on loopback. */
export function providerClass(p: Pick<ProviderConfig, 'kind' | 'baseUrl'> | undefined): ProviderClass {
  if (!p) return 'other';
  if (isLocalProvider(p.kind)) return 'local';
  if (p.kind === 'openai-compat' && LOOPBACK.test(p.baseUrl ?? '')) return 'local';
  return 'cloud';
}

export const providerKey = (s: Pick<SessionSummary, 'providerId'>): string => (s.providerId ? `p:${s.providerId}` : 'p:');

/** One facet per configured provider, plus the chats' providers since removed, plus chats with none yet. */
export function providerFacets(providers: ReadonlyArray<Pick<ProviderConfig, 'id' | 'label' | 'kind' | 'baseUrl'>>, sessions: ReadonlyArray<Pick<SessionSummary, 'providerId'>>): Facet[] {
  const out: Facet[] = providers.map((p) => ({ key: `p:${p.id}`, name: p.label || p.id, section: providerClass(p) }));
  const known = new Set(out.map((f) => f.key));
  for (const s of sessions) {
    const key = providerKey(s);
    if (known.has(key)) continue;
    known.add(key);
    out.push({ key, name: s.providerId ? `${s.providerId} (removed)` : 'No model yet', section: 'other' });
  }
  return out;
}

/**
 * Facets holding the chats that match: a facet whose own name has every word
 * keeps all its chats (in range), any other keeps the chats `match` accepts.
 * Facets left empty are dropped. Chats newest first.
 */
export function facetResults<T extends Searchable>(sessions: readonly T[], facets: readonly Facet[], keyOf: (s: T) => string, query: string, matches: (s: T) => boolean, range?: DateRange | null): Array<FacetResult<T>> {
  const terms = finderTerms(query);
  const by = new Map<string, T[]>();
  for (const s of sessions) {
    if (s.incognito || !chatInRange({ createdAt: s.createdAt ?? s.updatedAt, updatedAt: s.updatedAt }, range)) continue;
    const k = keyOf(s);
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  return facets.flatMap((f) => {
    const all = by.get(f.key) ?? [];
    const named = terms.length > 0 && terms.every((t) => `${f.name} ${f.section ?? ''}`.toLowerCase().includes(t));
    const kept = (!terms.length || named ? all : all.filter(matches)).sort(byRecent);
    return kept.length ? [{ ...f, sessions: kept }] : [];
  });
}

/** Short label for a picked range, "Mar 3 – Mar 9" (one day reads once). */
export function rangeLabel(range: DateRange | null | undefined): string {
  if (!range) return 'Any date';
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  const a = fmt(range.from), b = fmt(range.to);
  return a === b ? a : `${a} – ${b}`;
}

/** The 6×7 day grid for a month view, weeks starting Sunday, as local midnight timestamps. */
export function monthGrid(year: number, month: number): number[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime());
}
