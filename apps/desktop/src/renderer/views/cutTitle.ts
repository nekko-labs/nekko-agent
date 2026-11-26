/** Longest hover text: the whole of a typical first message, not a 2,000-character wall. */
const HOVER_CHARS = 600;
/** The engine cuts a placeholder title at 48 UTF-16 units; anything much shorter was chosen, not cut. */
const MIN_CUT = 40;

const fold = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * A chat title that is the opening of its first message cut short (the
 * engine's placeholder, older ones without a "…"): the title to show, ending
 * in "…", and the message to show on hover. `null` for any other title.
 */
export function cutTitle(title: string, firstUserText: string | undefined): { shown: string; full: string } | null {
  if (!firstUserText) return null;
  const base = fold(title.endsWith('…') ? title.slice(0, -1) : title);
  const message = fold(firstUserText);
  if (base.length < MIN_CUT || message.length <= base.length || !message.startsWith(base)) return null;
  const full = message.length > HOVER_CHARS ? `${message.slice(0, HOVER_CHARS).trimEnd()}…` : message;
  return { shown: `${base}…`, full };
}
