import type { AppSettings, PlanStep } from '@nekko-agent/shared';

export type PlanDisplay = NonNullable<AppSettings['planDisplay']>;
export const PLAN_DISPLAYS: { value: PlanDisplay; label: string }[] = [
  { value: 'full', label: 'Show full plan' }, { value: 'balanced', label: 'Balanced · 3 rows (default)' },
  { value: 'one', label: 'Show 1 row' }, { value: 'hidden', label: 'Hide entirely' },
];

export function planRows(plan: PlanStep[], full: boolean, mode: PlanDisplay) {
  const completed = plan.filter(s => s.status === 'done' || s.status === 'skipped');
  const remaining = plan.filter(s => s.status === 'active' || s.status === 'pending');
  const prioritized = [...remaining.filter(s => s.status === 'active'), ...remaining.filter(s => s.status === 'pending')];
  return { completed, visible: full ? remaining : prioritized.slice(0, mode === 'one' ? 1 : 3) };
}
