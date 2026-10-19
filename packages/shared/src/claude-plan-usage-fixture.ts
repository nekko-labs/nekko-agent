/**
 * Example plan usage for the Claude Agent plan-usage UI (the `usage_limits`
 * row for `subscription`, awaiting Anthropic's approval).
 *
 * There is no sanctioned source of Claude plan usage today, so nothing real
 * ever fills this UI. This fixture feeds it in the dev-only policy preview
 * (`NEKKO_CLAUDE_POLICY_PREVIEW=subscription`) and in tests, and every surface
 * that shows it must print `CLAUDE_PLAN_USAGE_EXAMPLE_LABEL` beside it. The
 * numbers are made up.
 */

import type { SubscriptionLimits } from './limits.js';

export const CLAUDE_PLAN_USAGE_EXAMPLE_LABEL = 'Example data';

/** Example windows, relative to `now` so the reset times always read as upcoming. */
export function claudePlanUsageExample(now: number = Date.now()): SubscriptionLimits & { exampleLabel: string } {
  const hour = 60 * 60 * 1000;
  return {
    exampleLabel: CLAUDE_PLAN_USAGE_EXAMPLE_LABEL,
    windows: [
      { id: 'session', label: 'Current session', scope: 'session', usedPercent: 42, resetAt: now + 3 * hour, status: 'allowed' },
      { id: 'weekly', label: 'This week', scope: 'weekly', usedPercent: 68, resetAt: now + 4 * 24 * hour, status: 'allowed' },
      {
        id: 'weekly-opus',
        label: 'This week (Opus)',
        scope: 'model',
        modelFamily: 'opus',
        usedPercent: 81,
        resetAt: now + 4 * 24 * hour,
        status: 'warning',
      },
    ],
    creditsState: 'unknown',
    updatedAt: now,
    staleAfterMs: 5 * 60 * 1000,
  };
}
