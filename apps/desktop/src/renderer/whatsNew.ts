import { RELEASE_NOTES_URL } from '@nekko-agent/shared';
import bundled from './whatsNew.json';

/**
 * The highlights behind the "What's new" sheet. They ship in the build
 * (`whatsNew.json`, keyed by MAJOR.MINOR), so the sheet needs no network.
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

/** The line a build belongs to: `0.10.1004` is in `0.10`. */
export function lineOf(version: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(version);

  return match ? `${match[1]}.${match[2]}` : null;
}

/** The file is written by a release step: read what is well formed, drop the rest. */
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

  const list = (data as Record<string, unknown>)[line];
  if (!Array.isArray(list)) return [];

  return list.map(readHighlight).filter((item): item is Highlight => item !== null);
}

/** The first three, and what "Show more" adds. */
export function splitHighlights(list: Highlight[]): { top: Highlight[]; rest: Highlight[] } {
  return { top: list.slice(0, TOP_HIGHLIGHTS), rest: list.slice(TOP_HIGHLIGHTS) };
}

/**
 * The GitHub release page for the running version. Every version the updater
 * installs is a release with its own page; a local build is not, and gets the
 * latest release instead.
 */
export function releaseUrl(version: string): string {
  return /^\d+\.\d{2}\.\d{4}$/.test(version) ? `${REPO_URL}/releases/tag/v${version}` : RELEASE_NOTES_URL;
}

/** Open the sheet from anywhere: the update pill, Settings, About, the palette. */
export const openWhatsNew = () => window.dispatchEvent(new Event('nekko:whats-new'));

export const prUrl = (pr: number): string => `${REPO_URL}/pull/${pr}`;
