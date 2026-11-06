import { expect, it } from 'vitest';
import { turnStatsParts } from './TurnStatsLine.js';

it('keeps a future provider effort label legible in the turn metrics', () => {
  const parts = turnStatsParts({ providerId: 'p', modelId: 'm', effort: 'future-level', inputTokens: 1, outputTokens: 1, wallMs: 1000, calls: 1 });
  expect(parts).toContain('future-level effort');
  expect(parts.join(' ')).not.toContain('undefined');
});
