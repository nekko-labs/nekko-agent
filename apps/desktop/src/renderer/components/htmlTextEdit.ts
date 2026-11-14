import type { PreviewTextEdit } from '@nekko-agent/shared';

/**
 * Put a text change made by clicking into a running page back into the page's
 * source, touching nothing else: the file keeps its formatting, attributes and
 * scripts. Only an element whose source is plain text (no tags or comments
 * inside) can change, found by its tag, its old text and which such element
 * with that text it is. Anything else is refused (null), and the person edits
 * it in the code instead.
 *
 * shortcut: elements are matched by text and order, so a page whose script adds
 * an element with the same text before the one clicked can pick the wrong one;
 * upgrade to source positions from a real HTML parser if that shows up.
 */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Decode the entities a text run uses; null when it uses one this does not know, so it never mismatches silently. */
export function decodeEntities(text: string): string | null {
  let unknown = false;
  const out = text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);/gi, (all, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    if (lower in NAMED) return NAMED[lower];
    unknown = true;
    return all;
  });
  return unknown ? null : out;
}

export const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A tag name a page may report: letters, digits and dashes, starting with a letter. */
const TAG = /^[a-z][a-z0-9-]{0,40}$/;
/** Text a page may report: bounded, so a hostile page cannot grow the file without limit. */
export const EDIT_TEXT_MAX = 20_000;

/** A text change a page reported, or null for anything else it may post (the page is untrusted). */
export function readPreviewTextEdit(data: unknown): PreviewTextEdit | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.nekkoPreview !== 'edit' || typeof d.tag !== 'string' || typeof d.old !== 'string' || typeof d.text !== 'string') return null;
  const tag = d.tag.toLowerCase();
  const n = d.occurrence;
  if (!TAG.test(tag) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return null;
  if (d.old.length > EDIT_TEXT_MAX || d.text.length > EDIT_TEXT_MAX) return null;
  return { nekkoPreview: 'edit', tag, old: d.old, occurrence: n, text: d.text };
}

/** The source with the edit made, or null when the element can't be found exactly once at that place. */
export function applyTextEdit(source: string, edit: Pick<PreviewTextEdit, 'tag' | 'old' | 'occurrence' | 'text'>): string | null {
  if (!TAG.test(edit.tag) || edit.text === edit.old) return null;
  const element = new RegExp(`(<${edit.tag}(?:\\s[^>]*)?>)([^<]*)(</${edit.tag}\\s*>)`, 'gi');
  let seen = 0;
  for (const m of source.matchAll(element)) {
    if (decodeEntities(m[2]) !== edit.old) continue;
    if (seen++ !== edit.occurrence) continue;
    const start = m.index! + m[1].length;
    return source.slice(0, start) + escapeText(edit.text) + source.slice(start + m[2].length);
  }
  return null;
}
