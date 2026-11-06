/**
 * Work modes: a per-chat, one-click way of working (Better review, Design,
 * Best output) that brings its skills with it, so the user never has to
 * remember or type them. Design: reports/modes.md.
 *
 * A work mode only shapes how the agent works. It never touches permissions
 * (Ask / Guardrails / YOLO), tools, Offline, Incognito or guardrail rules:
 * those stay the ceiling it works under.
 *
 * v1 is prompt-level: the mode's instructions and its skills' text join the
 * system prompt for every turn while the mode is on. Engine-enforced phases
 * and on-demand skill loading are planned, not built.
 *
 * The prompt text is computed here and embedded in the daemon's turn catalog
 * (crates/nekko-turn/src/catalog.json) by the turn-plan golden test, so both
 * engines send the same words.
 */
import { SKILLS } from './skills.js';
import { MARKET_SKILLS } from './skills-market.js';

export type WorkModeId = 'default' | 'better-review' | 'design' | 'best-output';

export interface WorkModeDef {
  id: WorkModeId;
  label: string;
  /** One line under the label in the menu. */
  description: string;
  /** Rough extra cost, shown so a heavier mode is chosen knowingly. */
  cost?: string;
  /** How the agent works while the mode is on. Empty for the default. */
  instructions: string;
  /** Skills (built-in or catalog, by name) whose text the mode brings along. */
  skills: string[];
}

export const WORK_MODES: WorkModeDef[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Normal chat, no extra passes.',
    instructions: '',
    skills: [],
  },
  {
    id: 'better-review',
    label: 'Better review',
    description: 'Focused reviewers, then a check that drops false findings.',
    cost: 'More tokens and time',
    instructions: [
      'When the user asks for a review (code, a diff, a PR, a document), review in separate passes: correctness and edge cases, security, tests, then simplicity.',
      'Every finding cites the exact file and line (or section) and says why it matters. A finding you cannot point to is not reported.',
      'Before reporting, verify each finding against the actual code; drop anything you could not confirm. When spawn_agent is available, have a separate reviewer check the findings, preferably on a different model of the same provider.',
      'Report findings ranked by severity, then say what you did not check.',
    ].join('\n'),
    skills: ['review', 'security-review', 'review-council'],
  },
  {
    id: 'design',
    label: 'Design',
    description: 'Prototype, look at it, critique, refine.',
    cost: 'More tokens and time',
    instructions: [
      'For visual or interface work: build a self-contained prototype first (HTML/CSS/SVG in nekko-designs/ unless the project has a convention), then look at the result before calling it done.',
      'When you can capture or screenshot it, do so and critique what you actually see: hierarchy, spacing, contrast, alignment, states, narrow and wide widths, light and dark themes.',
      'Revise at least once based on that critique, and say what changed between rounds. Never claim a visual result you did not inspect.',
    ].join('\n'),
    skills: ['a11y-audit'],
  },
  {
    id: 'best-output',
    label: 'Best output',
    description: 'Plan, draft, critique, revise before answering.',
    cost: 'More tokens and time',
    instructions: [
      'Before the final answer: make a short plan, write a draft, critique the draft against the request (missing parts, errors, weak spots, unverified claims), then revise.',
      'For work that can be checked (code, data, facts), check it with the tools available instead of judging by reading. When spawn_agent is available and the task is substantial, ask a separate critic for the review.',
      'Deliver only the revised result, and state any remaining uncertainty plainly.',
    ].join('\n'),
    skills: ['plan'],
  },
];

export function getWorkMode(id: string | undefined | null): WorkModeDef {
  return WORK_MODES.find((m) => m.id === id) ?? WORK_MODES[0];
}

/** A skill's text as a mode brings it: catalog instructions, else its built-in template. */
function skillText(name: string): string | undefined {
  const market = MARKET_SKILLS.find((s) => s.name === name);
  if (market) return market.instructions || market.template;
  return SKILLS.find((s) => s.name === name)?.template;
}

/**
 * The text a mode adds to the system prompt, or '' for the default and any
 * unknown id. Pure and deterministic: the daemon embeds the result.
 */
export function workModePrompt(id: string | undefined | null): string {
  const mode = getWorkMode(id);
  if (!mode.instructions) return '';
  const skills = mode.skills
    .map((name) => ({ name, text: skillText(name) }))
    .filter((s): s is { name: string; text: string } => !!s.text)
    .map((s) => `- ${s.name}: ${s.text}`);
  return [
    `Work mode: ${mode.label} (chosen by the user for this chat). It shapes how you work; it does not change permissions, tools or guardrails.`,
    mode.instructions,
    ...(skills.length ? ['Skills this mode applies automatically (the user does not need to invoke them):', ...skills] : []),
  ].join('\n');
}

/** Every mode's prompt text by id, for the daemon's catalog. */
export function workModePrompts(): Record<string, string> {
  return Object.fromEntries(WORK_MODES.map((m) => [m.id, workModePrompt(m.id)]));
}
