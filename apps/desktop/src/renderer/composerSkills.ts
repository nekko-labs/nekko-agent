import type { SkillDef } from '@nekko-agent/shared';

/** The `/` query the slash menu is searching for, and where its `/` sits in the draft. */
export interface SlashTrigger {
  query: string;
  start: number;
}

/**
 * A `/word` at the end of the draft, after a space or line break, like `@` file
 * mentions. `a/b` and `http://` do not count.
 */
function trailingSlashToken(draft: string): SlashTrigger | null {
  const m = draft.match(/(?:^|\s)\/([^\s/]*)$/);
  if (!m) return null;
  return { query: m[1], start: draft.length - m[1].length - 1 };
}

/**
 * The slash menu's query, or null when the menu should stay shut. A draft that
 * starts with `/` searches its whole line (saved prompts may contain spaces);
 * otherwise a `/` typed after existing text searches just the trailing token.
 */
export function slashTrigger(draft: string): SlashTrigger | null {
  if (draft.startsWith('/') && !draft.includes('\n')) return { query: draft.slice(1), start: 0 };
  return trailingSlashToken(draft);
}

/** Swap the slash query for a saved prompt's text, keeping everything typed before it. */
export function draftAfterPromptSelection(draft: string, text: string): string {
  const trigger = slashTrigger(draft);
  return trigger ? draft.slice(0, trigger.start) + text : text;
}

/** Attaching a skill must not consume the prompt; only the slash query is consumed. */
export function draftAfterSkillSelection(draft: string, skill: SkillDef): string {
  // A lone slash query is a skill search, not a prompt. Checking the current
  // draft also keeps text typed after a stale menu was shown.
  if (/^\/\S*$/.test(draft)) return skill.kind === 'goal' ? '/goal ' : '';
  // A `/query` typed after the prompt is consumed; the prompt before it stays.
  const trailing = trailingSlashToken(draft);
  if (trailing) draft = draft.slice(0, trailing.start);
  if (skill.kind !== 'goal') return draft;

  // Goal dispatch still uses the leading command, with the draft as its condition.
  return /^\/goal\s/i.test(draft) ? draft : `/goal ${draft}`;
}
