import type { SkillDef } from '@nekko-agent/shared';

/** A `/` or `@` query being typed: the word after the sigil, and the span `[start, end)` it occupies. */
export interface ComposerTrigger {
  query: string;
  start: number;
  end: number;
}

/** A draft after a menu pick, with where the caret goes. */
export interface ComposerEdit {
  text: string;
  caret: number;
}

/**
 * The `/word` or `@word` that ends at the caret, after a space, a line break or
 * the start of the draft. The caret must sit at the end of the word (the next
 * character is whitespace or nothing), so `a/b`, `http://` and a caret inside
 * a word do not count. A negative caret (a selected range) never triggers.
 */
function tokenAt(draft: string, caret: number, sigil: '/' | '@'): ComposerTrigger | null {
  if (caret < 0 || caret > draft.length) return null;
  if (caret < draft.length && !/\s/.test(draft[caret])) return null;
  const m = draft.slice(0, caret).match(sigil === '/' ? /(?:^|\s)\/([^\s/]*)$/ : /(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1, end: caret };
}

/**
 * The slash menu's query, or null when the menu should stay shut. With the
 * caret at the end, a draft that starts with `/` searches its whole line (saved
 * prompts may contain spaces); otherwise the `/word` ending at the caret does.
 */
export function slashTrigger(draft: string, caret = draft.length): ComposerTrigger | null {
  if (caret === draft.length && draft.startsWith('/') && !draft.includes('\n')) return { query: draft.slice(1), start: 0, end: draft.length };
  return tokenAt(draft, caret, '/');
}

/** The `@` file menu's query: the `@word` ending at the caret. */
export function atTrigger(draft: string, caret = draft.length): ComposerTrigger | null {
  return tokenAt(draft, caret, '@');
}

/** Swap a trigger's span for `insert`, with the caret right after it. */
function replaceSpan(draft: string, trigger: ComposerTrigger, insert: string): ComposerEdit {
  return { text: draft.slice(0, trigger.start) + insert + draft.slice(trigger.end), caret: trigger.start + insert.length };
}

/** Swap the slash query for a saved prompt's text, keeping everything around it. */
export function promptSelectionEdit(draft: string, text: string, caret = draft.length): ComposerEdit {
  const trigger = slashTrigger(draft, caret);
  return trigger ? replaceSpan(draft, trigger, text) : { text, caret: text.length };
}

/** Swap the `@query` for the picked file's mention, followed by a space. */
export function fileSelectionEdit(draft: string, relPath: string, caret = draft.length): ComposerEdit {
  const trigger = atTrigger(draft, caret);
  if (!trigger) return { text: draft, caret };
  const spaced = /^\s/.test(draft.slice(trigger.end));
  const edit = replaceSpan(draft, trigger, `@${relPath}${spaced ? '' : ' '}`);
  return spaced ? { ...edit, caret: edit.caret + 1 } : edit;
}

/** Attaching a skill must not consume the prompt; only the slash query is consumed. */
export function skillSelectionEdit(draft: string, skill: SkillDef, caret = draft.length): ComposerEdit {
  // A lone slash query is a skill search, not a prompt. Checking the current
  // draft also keeps text typed after a stale menu was shown.
  if (/^\/\S*$/.test(draft)) {
    const text = skill.kind === 'goal' ? '/goal ' : '';
    return { text, caret: text.length };
  }
  // A `/query` typed into the prompt is consumed; the text around it stays.
  // Removing it mid-line drops one of the two spaces it sat between.
  let edit: ComposerEdit = { text: draft, caret };
  const token = tokenAt(draft, caret, '/');
  if (token) {
    const after = draft.slice(token.end);
    const before = draft.slice(0, token.start);
    edit = { text: before + (/^ /.test(after) && /(^|\s)$/.test(before) ? after.slice(1) : after), caret: token.start };
  }
  if (skill.kind !== 'goal' || /^\/goal\s/i.test(edit.text)) return edit;

  // Goal dispatch still uses the leading command, with the draft as its condition.
  return { text: `/goal ${edit.text}`, caret: edit.caret + '/goal '.length };
}

/** The draft after a skill pick, for callers that don't place the caret. */
export function draftAfterSkillSelection(draft: string, skill: SkillDef, caret = draft.length): string {
  return skillSelectionEdit(draft, skill, caret).text;
}
