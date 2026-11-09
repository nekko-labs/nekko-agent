import type { ContextItem } from '@nekko-agent/shared';

/**
 * Semantic color tokens for inline styles.
 *
 * Every status color in the renderer resolves through here (never a raw hex),
 * so a theme swap in `styles.css` moves every badge, dot, chip and chart at
 * once instead of drifting per screen. Tailwind classes for the same tokens
 * (`text-danger`, `bg-success-soft`, …) are declared in `tailwind.config.js`.
 */

/** State of a thing: healthy, broken, needs attention, informational, idle. */
export const STATUS = {
  success: 'var(--success)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  neutral: 'var(--neutral)',
  /** Work in flight (a run, an experiment, a terminal command). */
  running: 'var(--running)',
  /** The stand-out item in a set (best experiment, champion). */
  highlight: 'var(--highlight)',
} as const;

/** The same states as words: darker where the base hue falls under 4.5:1 as text. */
export const STATUS_TEXT = {
  success: 'var(--success-text)',
  danger: 'var(--danger-text)',
  warning: 'var(--warning-text)',
  info: 'var(--info-text)',
  attention: 'var(--attention-text)',
} as const;

/** Translucent fills of the same states, for chips and banners. */
export const STATUS_SOFT = {
  success: 'var(--success-soft)',
  danger: 'var(--danger-soft)',
  warning: 'var(--warning-soft)',
  info: 'var(--info-soft)',
  neutral: 'var(--neutral-soft)',
} as const;

export type StatusTone = keyof typeof STATUS;

/** Where a piece of context came from — shared by the metrics bar, the context
 *  inspector and the prompt analyzer so one source reads as one color. */
export const CATEGORY = {
  system: 'var(--cat-system)',
  conversation: 'var(--cat-conversation)',
  guideline: 'var(--cat-guideline)',
  memory: 'var(--cat-memory)',
  file: 'var(--cat-file)',
  connector: 'var(--cat-connector)',
  index: 'var(--cat-index)',
  skill: 'var(--cat-skill)',
  spec: 'var(--cat-spec)',
} as const;

/** Base theme surfaces, for the same reason. */
export const SURFACE = {
  paper: 'var(--paper)',
  surface: 'var(--surface)',
  surface2: 'var(--surface-2)',
  line: 'var(--line)',
  ink: 'var(--ink)',
  inkSoft: 'var(--ink-soft)',
  inkFaint: 'var(--ink-faint)',
  accent: 'var(--accent)',
  accentSoft: 'var(--accent-soft)',
} as const;

/**
 * Context provenance colors, one map for every surface that visualises where a
 * turn's tokens came from (chat metrics bar, context inspector, prompt
 * analyzer) so a source is the same color everywhere.
 */
export const CONTEXT_SOURCE: Record<ContextItem['source'], string> = {
  system: CATEGORY.system,
  conversation: CATEGORY.conversation,
  guideline: CATEGORY.guideline,
  memory: CATEGORY.memory,
  'attached-file': CATEGORY.file,
  connector: CATEGORY.connector,
  'index-snippet': CATEGORY.index,
  skill: CATEGORY.skill,
};
