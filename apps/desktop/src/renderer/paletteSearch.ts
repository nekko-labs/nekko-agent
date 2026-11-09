/**
 * Search everything from the Ctrl/Cmd+K palette: commands, Settings groups,
 * individual settings, chats, the messages inside them and the artifacts they
 * made. Pure helpers, kept out of the component so they test without a DOM.
 *
 * Every typed word has to be found somewhere in a result, either as typed or
 * as one of its synonyms ("prefs" finds Settings). Results rank by where the
 * words were found (a title beats a path, which beats a description, which
 * beats a message body), literal matches beat synonyms, and messages always
 * come after everything else: they are the noisiest source.
 */

/** What a result is; each has its own filter chip (pages count as settings). */
export type PaletteKind = 'command' | 'page' | 'setting' | 'chat' | 'message' | 'artifact';
export type PaletteFilter = 'all' | 'command' | 'setting' | 'chat' | 'message' | 'artifact';

export const PALETTE_FILTERS: ReadonlyArray<{ id: PaletteFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'command', label: 'Commands' },
  { id: 'setting', label: 'Settings' },
  { id: 'chat', label: 'Chats' },
  { id: 'message', label: 'Messages' },
  { id: 'artifact', label: 'Artifacts' },
];

export const filterOf = (kind: PaletteKind): PaletteFilter => (kind === 'page' ? 'setting' : kind);

/**
 * Words people use for the same thing. A typed word that is one of these (or,
 * from four letters, the start of one) also matches the rest of its group.
 */
export const SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ['settings', 'setting', 'preferences', 'preference', 'prefs', 'pref', 'config', 'configuration', 'configure', 'options', 'option'],
  ['theme', 'appearance', 'colors', 'colours', 'color', 'colour', 'look'],
  ['delete', 'remove', 'erase', 'trash'],
  ['chat', 'chats', 'agent', 'agents', 'conversation', 'conversations', 'session', 'sessions', 'thread'],
  ['notifications', 'notification', 'notify', 'alerts', 'alert'],
  ['shortcut', 'shortcuts', 'hotkey', 'hotkeys', 'keybinding', 'keybindings', 'keyboard'],
  ['language', 'locale', 'translation', 'translate'],
  ['privacy', 'telemetry', 'analytics', 'tracking'],
  ['connectors', 'connector', 'integrations', 'integration', 'mcp', 'plugins', 'plugin'],
  ['library', 'artifacts', 'artifact', 'files', 'outputs'],
  ['terminal', 'shell', 'console', 'cli', 'command line'],
  ['archive', 'archived', 'complete', 'completed', 'done'],
  ['new', 'create', 'start', 'add'],
  ['close', 'quit', 'exit', 'shut down', 'shutdown'],
  ['update', 'updates', 'upgrade'],
  ['help', 'support', 'feedback', 'bug'],
  ['model', 'models', 'llm', 'llms'],
  ['font', 'fonts', 'text', 'typeface'],
  ['animation', 'animations', 'motion'],
  ['project', 'projects', 'folder', 'folders', 'workspace', 'workspaces', 'group', 'groups'],
  ['phone', 'mobile', 'iphone', 'android'],
];

/** One typed word and everything it also stands for. `alts[0]` is the word itself. */
export interface Term { raw: string; alts: string[] }

export function expandTerm(raw: string): Term {
  const alts = new Set([raw]);
  for (const group of SYNONYM_GROUPS) {
    if (group.some((w) => w === raw || (raw.length >= 4 && w.startsWith(raw)))) for (const w of group) alts.add(w);
  }
  // A synonym that already contains the word adds nothing: the word matches it.
  return { raw, alts: [raw, ...[...alts].filter((a) => a !== raw && !a.includes(raw))] };
}

export const paletteTerms = (query: string): Term[] =>
  [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].map(expandTerm);

/** Something the palette can find. Lower-case copies are made once, when the doc is built. */
export interface PaletteDoc<T = unknown> {
  id: string;
  kind: PaletteKind;
  /** The last breadcrumb: what the row is. */
  title: string;
  /** The breadcrumbs before the title ("Settings", "Customize"). */
  crumbs: string[];
  /** The second row when no body text matched: a description, a file name. */
  context?: string;
  /** Searched but never shown (a chat's provider, a setting's extra words). */
  keywords?: string;
  /** Longer texts a snippet is cut from (a chat's description, its messages). */
  body?: readonly BodyText[];
  /** Every word must be found in `body` (message results), not elsewhere. */
  bodyOnly?: boolean;
  /** When it last changed, for ties and the empty list. */
  at?: number;
  /** Whatever the component needs to act on the row. */
  data?: T;
}

export interface BodyText { text: string; lower?: string; id?: string }

export interface PaletteHit<T = unknown> {
  doc: PaletteDoc<T>;
  score: number;
  /** The second row's text: a snippet around the match, else the doc's context. */
  context: string;
  /** The body entry the snippet came from, and how many body entries matched. */
  bodyIndex?: number;
  bodyCount?: number;
}

const lower = (s: string) => s.toLowerCase();
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Where `needle` first starts a word in `hay`, else where it first appears, else -1. */
function position(hay: string, needle: string): { at: number; wordStart: boolean } | null {
  let i = hay.indexOf(needle);
  if (i < 0) return null;
  const first = i;
  while (i >= 0) {
    if (!isWordChar(hay[i - 1])) return { at: i, wordStart: true };
    i = hay.indexOf(needle, i + 1);
  }
  return { at: first, wordStart: false };
}

type Strength = 'word' | 'literal' | 'synonym-word' | 'synonym';

function strength(hay: string, term: Term): Strength | null {
  const lit = position(hay, term.raw);
  if (lit) return lit.wordStart ? 'word' : 'literal';
  let best: Strength | null = null;
  for (const alt of term.alts.slice(1)) {
    const p = position(hay, alt);
    if (p?.wordStart) return 'synonym-word';
    if (p) best = 'synonym';
  }
  return best;
}

/** Points per field and strength: a title word beats everything, a body match counts least. */
const FIELD_POINTS = {
  title: { word: 60, literal: 45, 'synonym-word': 36, synonym: 28 },
  crumbs: { word: 26, literal: 22, 'synonym-word': 20, synonym: 16 },
  context: { word: 18, literal: 14, 'synonym-word': 12, synonym: 10 },
  keywords: { word: 16, literal: 12, 'synonym-word': 11, synonym: 9 },
  body: { word: 9, literal: 7, 'synonym-word': 6, synonym: 5 },
} as const;

/** A small lean so a command outranks a setting it ties with, and so on down. */
const KIND_POINTS: Record<PaletteKind, number> = { command: 12, page: 10, setting: 10, chat: 8, artifact: 4, message: 0 };

/** Messages sit below every other kind, however well they match. */
export const tierOf = (kind: PaletteKind): number => (kind === 'message' ? 1 : 0);

const SNIPPET_BEFORE = 28;
const SNIPPET_CHARS = 140;

/** A one-line piece of `text` starting a little before the first match of any term. */
export function snippetFor(text: string, terms: readonly Term[]): string {
  const hay = lower(text);
  let at = -1;
  for (const t of terms) for (const a of t.alts) {
    const i = hay.indexOf(a);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let start = Math.max(0, at - SNIPPET_BEFORE);
  // Open on a word boundary, not mid-word, when one is close enough.
  if (start > 0) { const sp = text.slice(start, at).search(/\s/); if (sp >= 0) start += sp + 1; }
  const piece = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + piece + (start + SNIPPET_CHARS < text.length ? '…' : '');
}

/** The terms without their synonyms: long texts match only what was typed. */
export const literal = (terms: readonly Term[]): Term[] => terms.map((t) => ({ raw: t.raw, alts: [t.raw] }));

/** Score one doc against the terms, or null when some word is found nowhere. */
export function scoreDoc<T>(doc: PaletteDoc<T>, terms: readonly Term[], query = ''): PaletteHit<T> | null {
  const title = lower(doc.title);
  // The first crumb names the type ("Chats", "Settings"); searching it would
  // list every chat for "agent". Settings groups are the exception: "prefs"
  // should list them, and they have no other path.
  const crumbs = lower((doc.kind === 'page' ? doc.crumbs : doc.crumbs.slice(1)).join(' '));
  const context = lower(doc.context ?? '');
  const keywords = lower(doc.keywords ?? '');
  const bodies = (doc.body ?? []).map((b) => b.lower ?? lower(b.text));
  let score = 0;
  for (const term of terms) {
    let best = 0;
    if (!doc.bodyOnly) {
      const fields: Array<[keyof typeof FIELD_POINTS, string]> = [['title', title], ['crumbs', crumbs], ['context', context], ['keywords', keywords]];
      for (const [field, hay] of fields) {
        const s = hay && strength(hay, term);
        if (s) best = Math.max(best, FIELD_POINTS[field][s]);
      }
    }
    // Long texts match only the typed word: synonyms there ("new" for "add")
    // would find nearly every message.
    if (best < FIELD_POINTS.body.word) {
      const plain = { raw: term.raw, alts: [term.raw] };
      for (const hay of bodies) {
        const s = strength(hay, plain);
        if (s) best = Math.max(best, FIELD_POINTS.body[s]);
        if (best === FIELD_POINTS.body.word) break;
      }
    }
    if (!best) return null;
    score += best;
  }
  const q = query.trim().toLowerCase();
  if (q && !doc.bodyOnly) {
    if (title === q) score += 80;
    else if (title.startsWith(q)) score += 40;
  }
  score += KIND_POINTS[doc.kind];

  // The second row: a snippet from the body entry holding the most words, when
  // the words were not all found in the title and path already.
  const shown = `${title}\n${crumbs}`;
  const unshown = terms.filter((t) => !t.alts.some((a) => shown.includes(a)));
  let bodyIndex: number | undefined;
  let bodyCount: number | undefined;
  let text = doc.context ?? '';
  if (bodies.length && (doc.bodyOnly || unshown.length)) {
    const want = literal(doc.bodyOnly ? terms : unshown);
    const hits = (hay: string) => want.filter((t) => t.alts.some((a) => hay.includes(a))).length;
    let bestHits = 0;
    let count = 0;
    bodies.forEach((hay, i) => {
      const n = hits(hay);
      if (n) count++;
      if (n > bestHits) { bestHits = n; bodyIndex = i; }
    });
    if (bodyIndex !== undefined && !(context && unshown.every((t) => t.alts.some((a) => context.includes(a))))) {
      text = snippetFor(doc.body![bodyIndex].text, want);
      bodyCount = count;
    } else bodyIndex = undefined;
  }
  return { doc, score, context: text, ...(bodyIndex !== undefined ? { bodyIndex, bodyCount } : {}) };
}

export interface PaletteResults<T> {
  /** Rows to draw, best first, messages last. */
  hits: Array<PaletteHit<T>>;
  /** Matches per filter chip, before any cap. */
  counts: Record<PaletteFilter, number>;
  /** Message matches left out of the All list (shown under the Messages chip). */
  moreMessages: number;
}

/** Messages the All list shows before pointing at the Messages chip. */
export const ALL_MESSAGE_CAP = 8;
/** Most rows the palette draws. */
export const PALETTE_LIMIT = 60;

/**
 * Search `docs` for `query` under one filter. With no query, the list is the
 * docs in the order given (commands first, newest chats after), no messages.
 */
export function searchPalette<T>(docs: readonly PaletteDoc<T>[], query: string, filter: PaletteFilter = 'all', opts: { limit?: number; messageCap?: number } = {}): PaletteResults<T> {
  const { limit = PALETTE_LIMIT, messageCap = ALL_MESSAGE_CAP } = opts;
  const terms = paletteTerms(query);
  const counts: Record<PaletteFilter, number> = { all: 0, command: 0, setting: 0, chat: 0, message: 0, artifact: 0 };
  let hits: Array<PaletteHit<T>>;
  if (!terms.length) {
    hits = docs.filter((d) => d.kind !== 'message').map((doc) => ({ doc, score: 0, context: doc.context ?? '' }));
  } else {
    hits = [];
    for (const doc of docs) {
      const hit = scoreDoc(doc, terms, query);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => tierOf(a.doc.kind) - tierOf(b.doc.kind) || b.score - a.score || (b.doc.at ?? 0) - (a.doc.at ?? 0));
  }
  for (const h of hits) { counts[filterOf(h.doc.kind)]++; counts.all++; }
  let moreMessages = 0;
  if (filter !== 'all') hits = hits.filter((h) => filterOf(h.doc.kind) === filter);
  else {
    // A chat already found by its title or description does not repeat as a message hit.
    const chats = new Set(hits.filter((h) => h.doc.kind === 'chat').map((h) => chatIdOf(h.doc)));
    let kept = 0;
    hits = hits.filter((h) => {
      if (h.doc.kind !== 'message') return true;
      if (chats.has(chatIdOf(h.doc))) return false;
      if (kept < messageCap) { kept++; return true; }
      moreMessages++;
      return false;
    });
  }
  return { hits: hits.slice(0, limit), counts, moreMessages };
}

/** `chat:<id>` and `message:<id>` docs name the same chat. */
const chatIdOf = (doc: PaletteDoc): string => doc.id.slice(doc.id.indexOf(':') + 1);

/** A piece of text, marked when it is part of a match. */
export interface Segment { text: string; hit: boolean }

/** Split `text` into plain and matched pieces for every term and synonym found in it. */
export function highlight(text: string, terms: readonly Term[]): Segment[] {
  if (!text || !terms.length) return text ? [{ text, hit: false }] : [];
  const hay = lower(text);
  const ranges: Array<[number, number]> = [];
  for (const t of terms) for (const a of t.alts) {
    for (let i = hay.indexOf(a); i >= 0; i = hay.indexOf(a, i + a.length)) ranges.push([i, i + a.length]);
  }
  if (!ranges.length) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
