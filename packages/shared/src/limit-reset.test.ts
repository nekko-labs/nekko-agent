import { describe, expect, it } from 'vitest';
import { isUsageLimitFailure, resetTimeInLimits, resetTimeInMessage, usageLimitResetAt } from './limit-reset.js';
import type { SubscriptionLimits } from './limits.js';

// 2026-11-15 10:00 in Tokyo (01:00 UTC).
const NOW = Date.UTC(2026, 10, 15, 1, 0);

describe('isUsageLimitFailure', () => {
  it('knows a spent plan or rate limit', () => {
    for (const m of [
      "You've hit your usage limit.",
      "You've hit your session limit · resets 3pm (Asia/Tokyo)",
      'Claude AI usage limit reached|1763215200',
      '5-hour limit reached ∙ resets 3pm',
      'Weekly limit reached ∙ resets Nov 20, 10am',
      '429 Rate limit exceeded',
    ]) expect(isUsageLimitFailure(m), m).toBe(true);
  });

  it('leaves context and output caps alone', () => {
    for (const m of [
      "openai 400: This model's maximum context length is 8192 tokens",
      'The reply hit the output limit (max_tokens).',
      'terminated',
    ]) expect(isUsageLimitFailure(m), m).toBe(false);
  });
});

describe('resetTimeInMessage', () => {
  it('reads Claude Code\'s epoch form, in seconds or milliseconds', () => {
    expect(resetTimeInMessage('Claude AI usage limit reached|1763215200', NOW)).toBe(1763215200_000);
    expect(resetTimeInMessage('usage limit reached|1763215200000', NOW)).toBe(1763215200_000);
  });

  it('reads a time in the zone the message names', () => {
    expect(resetTimeInMessage("You've hit your session limit · resets 3pm (Asia/Tokyo)", NOW)).toBe(Date.UTC(2026, 10, 15, 6, 0));
    expect(resetTimeInMessage('limit reached ∙ resets 7:30pm (America/New_York)', NOW)).toBe(Date.UTC(2026, 10, 16, 0, 30));
  });

  it('takes a time already past as tomorrow\'s', () => {
    expect(resetTimeInMessage('Session limit reached ∙ resets 9am (Asia/Tokyo)', NOW)).toBe(Date.UTC(2026, 10, 16, 0, 0));
  });

  it('reads a date with the time', () => {
    expect(resetTimeInMessage('Weekly limit reached ∙ resets Nov 20, 10am (Asia/Tokyo)', NOW)).toBe(Date.UTC(2026, 10, 20, 1, 0));
    expect(resetTimeInMessage('Weekly limit reached ∙ resets Jan 2 at 10am (UTC)', Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 10, 0));
  });

  it('reads a relative reset', () => {
    expect(resetTimeInMessage('Rate limit reached, resets in 2h 15m', NOW)).toBe(NOW + 135 * 60_000);
    expect(resetTimeInMessage('resets in 40 minutes', NOW)).toBe(NOW + 40 * 60_000);
  });

  it('ignores a bare number and a message with no reset', () => {
    expect(resetTimeInMessage('resets 3 times', NOW)).toBeNull();
    expect(resetTimeInMessage("You've hit your usage limit.", NOW)).toBeNull();
  });
});

const limits = (windows: Partial<SubscriptionLimits['windows'][number]>[]): SubscriptionLimits =>
  ({ windows: windows.map((w, i) => ({ id: `w${i}`, label: 'w', scope: 'session', usedPercent: 0, resetAt: 0, status: 'allowed', ...w })) }) as SubscriptionLimits;

describe('resetTimeInLimits', () => {
  it('takes the latest reset among spent windows', () => {
    const l = limits([
      { status: 'rate_limited', usedPercent: 100, resetAt: NOW + 3_600_000 },
      { status: 'allowed', usedPercent: 40, resetAt: NOW + 9_000_000 },
      { status: 'allowed', usedPercent: 100, resetAt: NOW + 7_200_000 },
    ]);
    expect(resetTimeInLimits(l, NOW)).toBe(NOW + 7_200_000);
  });

  it('is null with nothing spent or the reset already past', () => {
    expect(resetTimeInLimits(limits([{ usedPercent: 50, resetAt: NOW + 1000 }]), NOW)).toBeNull();
    expect(resetTimeInLimits(limits([{ status: 'rate_limited', resetAt: NOW - 1000 }]), NOW)).toBeNull();
    expect(resetTimeInLimits(undefined, NOW)).toBeNull();
  });
});

describe('usageLimitResetAt', () => {
  const spent = limits([{ status: 'rate_limited', usedPercent: 100, resetAt: NOW + 3_600_000 }]);

  it('prefers the message\'s own time, then the limits', () => {
    expect(usageLimitResetAt('Session limit reached ∙ resets 3pm (Asia/Tokyo)', spent, NOW)).toBe(Date.UTC(2026, 10, 15, 6, 0));
    expect(usageLimitResetAt("You've hit your usage limit.", spent, NOW)).toBe(NOW + 3_600_000);
  });

  it('is null for other failures, or when no reset is known', () => {
    expect(usageLimitResetAt('terminated', spent, NOW)).toBeNull();
    expect(usageLimitResetAt("You've hit your usage limit.", undefined, NOW)).toBeNull();
  });
});
