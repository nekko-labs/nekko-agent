import type { AppSettings } from '@nekko-agent/shared';

export type PlanDisplay = NonNullable<AppSettings['planDisplay']>;
/**
 * Folded, the plan is a timeline of dots. Balanced keeps the step being worked
 * readable under it; "one" (saved name kept) is the dots alone.
 */
export const PLAN_DISPLAYS: { value: PlanDisplay; label: string }[] = [
  { value: 'full', label: 'Show full plan' }, { value: 'balanced', label: 'Timeline and current step (default)' },
  { value: 'one', label: 'Timeline only' }, { value: 'hidden', label: 'Hide entirely' },
];
