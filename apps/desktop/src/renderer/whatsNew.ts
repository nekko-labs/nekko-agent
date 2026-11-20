import bundled from '../../../../docs/hub/whats-new.json';

/**
 * The highlights behind the "What's new" sheet. They come from the file the
 * website's What's new page is built from (`docs/hub/whats-new.json`, keyed by
 * MAJOR.MINOR) and ship in the build, so the sheet needs no network.
 * Pure helpers, kept out of the component so they test without a DOM.
 */

/** One change worth telling people about. */
export interface Highlight {
  title: string;
  /** One line. */
  detail: string;
  /** The pull request that made it. */
  pr: number;
  /** A bundled Gentleface icon name that fits the change; the sheet shows a default for one it does not know. */
  icon?: string;
}

/** How many highlights show before "Show more". */
export const TOP_HIGHLIGHTS = 3;

const REPO_URL = 'https://github.com/nekko-labs/nekko-agent';
const PAGE_URL = 'https://nekkoagent.com/whatsnew';

/** The line a build belongs to: `0.10.1004` is in `0.10`. */
export function lineOf(version: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(version);

  return match ? `${match[1]}.${match[2]}` : null;
}

/** The file is written by hand: read what is well formed, drop the rest (the site build is what rejects it). Unknown fields are ignored. */
function readHighlight(raw: unknown): Highlight | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const { title, detail, pr, icon } = raw as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) return null;
  if (typeof detail !== 'string' || !detail.trim()) return null;
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return null;

  return { title, detail, pr, ...(typeof icon === 'string' ? { icon } : {}) };
}

/** The highlights for the line `version` is in, in the file's order. */
export function highlightsFor(version: string, data: unknown = bundled): Highlight[] {
  const line = lineOf(version);
  if (!line || typeof data !== 'object' || data === null || !Object.hasOwn(data, line)) return [];

  const entry = (data as Record<string, unknown>)[line];
  const list = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).highlights : undefined;
  if (!Array.isArray(list)) return [];

  return list.map(readHighlight).filter((item): item is Highlight => item !== null);
}

/** The first three, and what "Show more" adds. */
export function splitHighlights(list: Highlight[]): { top: Highlight[]; rest: Highlight[] } {
  return { top: list.slice(0, TOP_HIGHLIGHTS), rest: list.slice(TOP_HIGHLIGHTS) };
}

/** The running line's section of the website's What's new page; a development build has a line too. */
export function whatsNewUrl(version: string): string {
  const line = lineOf(version);

  return line ? `${PAGE_URL}#${line}` : PAGE_URL;
}

const parts = (line: string) => line.split('.').map(Number) as [number, number];

/** The newer of two MAJOR.MINOR lines: what "seen" settles on, so a move back never lowers it. */
export function newerLine(a: string | null, b: string): string {
  if (!a) return b;

  const [x, y] = [parts(a), parts(b)];

  return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]) ? a : b;
}

/** The line this install has already seen: the last one shown, else the last version's (an install from before this existed), else none (a first install). */
export function seenLine(shown: string | null, lastVersion: string | null): string | null {
  return shown ?? (lastVersion ? lineOf(lastVersion) : null);
}

export interface AutoOpenInput {
  /** The running version. */
  version: string;
  /** `seenLine`: null on a first install. */
  seen: string | null;
  edition: 'desktop' | 'web';
  /** "Show after updates". */
  enabled: boolean;
  /** The running line has highlights. */
  hasHighlights: boolean;
  /** An agent is running or waiting for an answer, or another dialog is open. */
  busy: boolean;
}

/**
 * Whether the sheet opens by itself at launch: `open`, `wait` (it would, once
 * nothing is busy) or `no`. Only a release or nightly on a newer line than the
 * one seen opens it; a development build or the Local Web UI never does.
 */
export function autoOpen({ version, seen, edition, enabled, hasHighlights, busy }: AutoOpenInput): 'open' | 'wait' | 'no' {
  const line = lineOf(version);
  if (edition !== 'desktop' || !line || !/^\d+\.\d+\.\d+$/.test(version)) return 'no';
  if (!seen || newerLine(seen, line) === seen) return 'no';
  if (!enabled || !hasHighlights) return 'no';

  return busy ? 'wait' : 'open';
}

const LS_SHOWN = 'nekko_whats_new_line';

/** The line the sheet was last shown for on this install, or settled on without showing. */
export function shownLine(): string | null {
  try { return localStorage.getItem(LS_SHOWN); } catch { return null; }
}

/** Remember `line` as shown; a move to an older line never lowers it. */
export function markShown(line: string | null): void {
  if (!line) return;

  try { localStorage.setItem(LS_SHOWN, newerLine(shownLine(), line)); } catch { /* storage is off: it may open again */ }
}

/** Open the sheet from anywhere: the update pill, Settings, About, the palette. */
export const openWhatsNew = () => window.dispatchEvent(new Event('nekko:whats-new'));

export const prUrl = (pr: number): string => `${REPO_URL}/pull/${pr}`;
