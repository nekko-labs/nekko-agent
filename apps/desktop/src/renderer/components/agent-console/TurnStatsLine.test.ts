import { expect, it } from 'vitest';
import { cachedShare, turnStatsParts } from './TurnStatsLine.js';

it('keeps a future provider effort label legible in the turn metrics', () => {
  const parts = turnStatsParts({ providerId: 'p', modelId: 'm', effort: 'future-level', inputTokens: 1, outputTokens: 1, wallMs: 1000, calls: 1 });
  expect(parts).toContain('future-level effort');
  expect(parts.join(' ')).not.toContain('undefined');
});

it('says how much of the input came from the prompt cache, only when the provider counted it', () => {
  const base = { providerId: 'p', modelId: 'm', inputTokens: 15, outputTokens: 4, wallMs: 1000, calls: 1 };
  // A local llama.cpp turn whose prefix held: 2,439 reused, 15 prefilled.
  expect(cachedShare({ ...base, cacheReadTokens: 2_439 })).toBe(99);
  expect(turnStatsParts({ ...base, cacheReadTokens: 2_439 })).toContain('99% cached');
  // Never rounded up to a full hit it was not.
  expect(cachedShare({ ...base, inputTokens: 1, cacheReadTokens: 999 })).toBe(99);
  // No counter, or a cold cache: nothing claimed.
  expect(cachedShare(base)).toBeNull();
  expect(cachedShare({ ...base, cacheReadTokens: 0 })).toBeNull();
  expect(turnStatsParts(base).join(' ')).not.toContain('cached');
});
