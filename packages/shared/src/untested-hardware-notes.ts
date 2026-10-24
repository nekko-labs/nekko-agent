/**
 * The small notes shown beside UI the team could not try on real hardware
 * (2026-10-24, the owner's words, kept exactly: the curly apostrophe and the
 * 🙏 included). A caption row, never a modal; "let us know" opens the
 * public issue tracker. Swift and Kotlin keep their own copy beside the
 * feature.
 */

/** Beside the folding-phone layouts (panes, tabletop). */
export const FOLDABLE_UNTESTED_NOTE =
  'The Devs don’t have a foldable phone to test this one, so we tried our best without one! If you see any issues, please let us know 🙏';

/** Beside hardware keys and step-up (Settings → Security, the step-up sheet). */
export const SECURITY_KEY_UNTESTED_NOTE =
  'The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know 🙏';

/** Where "let us know" goes: the repository's public issue tracker. */
export const UNTESTED_HARDWARE_ISSUES_URL = 'https://github.com/nekko-labs/nekko-agent/issues/new';

export const UNTESTED_HARDWARE_NOTES = {
  foldable: FOLDABLE_UNTESTED_NOTE,
  securityKey: SECURITY_KEY_UNTESTED_NOTE,
  issuesUrl: UNTESTED_HARDWARE_ISSUES_URL,
} as const;

/** The words of a note that become the link. */
export const UNTESTED_HARDWARE_LINK_TEXT = 'let us know';

/** A note split around its link, so a surface can make only "let us know" tappable. */
export function splitUntestedNote(note: string): { before: string; link: string; after: string } {
  const i = note.lastIndexOf(UNTESTED_HARDWARE_LINK_TEXT);
  if (i < 0) return { before: note, link: '', after: '' };
  return { before: note.slice(0, i), link: UNTESTED_HARDWARE_LINK_TEXT, after: note.slice(i + UNTESTED_HARDWARE_LINK_TEXT.length) };
}
