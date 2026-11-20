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

/** Open the sheet from anywhere: the update pill, Settings, About, the palette. */
export const openWhatsNew = () => window.dispatchEvent(new Event('nekko:whats-new'));

export const prUrl = (pr: number): string => `${REPO_URL}/pull/${pr}`;
