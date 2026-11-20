import type { WorkProfile } from '@nekko-agent/shared';
import type { ArtifactKind } from '../../artifactsIndex.js';

/** How Library draws its files: a list across the page, or previews beside the list. */
export type LibraryLayout = 'list' | 'small' | 'large' | 'cards';

export const LIBRARY_LAYOUTS: ReadonlyArray<{ id: LibraryLayout; label: string }> = [
  { id: 'list', label: 'List' },
  { id: 'small', label: 'Small icons' },
  { id: 'large', label: 'Large icons' },
  { id: 'cards', label: 'Full cards' },
];

export const LIBRARY_LAYOUT_KEY = 'nekko.libraryLayout';
export const LIBRARY_COLLAPSED_KEY = 'nekko.libraryCollapsed';

const isLayout = (v: unknown): v is LibraryLayout => LIBRARY_LAYOUTS.some((l) => l.id === v);

export function loadLibraryLayout(): LibraryLayout {
  try {
    const v = localStorage.getItem(LIBRARY_LAYOUT_KEY);
    return isLayout(v) ? v : 'large';
  } catch { return 'large'; }
}

export function saveLibraryLayout(layout: LibraryLayout): void {
  try { localStorage.setItem(LIBRARY_LAYOUT_KEY, layout); } catch { /* The choice still holds for this visit. */ }
}

/** Groups the person folded away: a kind, or `computer:<name>` grouped by computer. Every group starts expanded. */
export function loadCollapsedKinds(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LIBRARY_COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch { return new Set(); }
}

export function saveCollapsedKinds(kinds: ReadonlySet<string>): void {
  try { localStorage.setItem(LIBRARY_COLLAPSED_KEY, JSON.stringify([...kinds])); } catch { /* Folding still works for this visit. */ }
}

/**
 * The kind of file each setup answer ("What do you mostly do?") makes most
 * often, which Library shows right after Designs. Just exploring keeps the usual order.
 */
export const LEAD_KIND: Partial<Record<WorkProfile, ArtifactKind>> = {
  developer: 'web',
  designer: 'design',
  writer: 'doc',
  student: 'doc',
  business: 'office',
};

/** The kind Library always shows first, whatever the setup answer. */
export const TOP_KIND: ArtifactKind = 'design';

/** Groups in their usual order: Designs first, then the setup answer's kind when it has files. */
export function orderForProfile<G extends { kind: { id: ArtifactKind } }>(groups: readonly G[], profile?: WorkProfile | null): G[] {
  const lead = profile ? LEAD_KIND[profile] : undefined;
  const firsts = [TOP_KIND, lead].map((id) => groups.find((g) => g.kind.id === id)).filter((g): g is G => !!g);
  return [...new Set([...firsts, ...groups])];
}

/** How many of a kind's newest files the previews show under All before "See all". */
export const PREVIEW_LIMIT: Record<Exclude<LibraryLayout, 'list'>, number> = { small: 16, large: 8, cards: 4 };

/**
 * How Library groups its files once it holds another computer's (#3144): by kind, as always,
 * or by the computer each file belongs to. And whether each file names its computer.
 */
export type LibraryGroupBy = 'kind' | 'computer';
export const LIBRARY_GROUP_BY_KEY = 'nekko.libraryGroupBy';
export const LIBRARY_SHOW_COMPUTER_KEY = 'nekko.libraryShowComputer';

export function loadLibraryGroupBy(): LibraryGroupBy {
  try { return localStorage.getItem(LIBRARY_GROUP_BY_KEY) === 'computer' ? 'computer' : 'kind'; } catch { return 'kind'; }
}

export function saveLibraryGroupBy(by: LibraryGroupBy): void {
  try { localStorage.setItem(LIBRARY_GROUP_BY_KEY, by); } catch { /* The choice still holds for this visit. */ }
}

/** On unless turned off. */
export function loadLibraryShowComputer(): boolean {
  try { return localStorage.getItem(LIBRARY_SHOW_COMPUTER_KEY) !== '0'; } catch { return true; }
}

export function saveLibraryShowComputer(on: boolean): void {
  try { localStorage.setItem(LIBRARY_SHOW_COMPUTER_KEY, on ? '1' : '0'); } catch { /* The choice still holds for this visit. */ }
}
