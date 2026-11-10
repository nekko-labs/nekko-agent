import { describe, expect, it } from 'vitest';
import type { SubscriptionLimits } from './limits.js';
import { CLAUDE_PLAN_RULES, claudePlanNote, claudePlanRule, claudePlanUsageNotice, type ClaudePlanRule } from './claude-plan-models.js';

const BEFORE_OFFER_ENDS = Date.parse('2026-11-12T12:00:00Z');
const AFTER_OFFER_ENDS = Date.parse('2026-11-17T08:00:00Z');

const limits = (windows: SubscriptionLimits['windows'], extra: Partial<SubscriptionLimits> = {}): SubscriptionLimits => ({
  windows, updatedAt: BEFORE_OFFER_ENDS, staleAfterMs: 300_000, ...extra,
});
const fableWeek = (usedPercent: number, status: 'allowed' | 'warning' | 'rate_limited') => ({
  id: 'weekly-fable', label: 'This week (Fable)', scope: 'model' as const, modelFamily: 'fable', usedPercent, resetAt: 0, status,
});

describe('claudePlanRule', () => {
  it('ends the Fable 5.2 Pro launch offer on its own at the instant it ends', () => {
    expect(claudePlanRule('claude-fable-5-2', 'pro', BEFORE_OFFER_ENDS)?.access).toBe('included');
    // 16 November 23:59:59 Pacific is 17 November 07:59:59 UTC.
    expect(claudePlanRule('claude-fable-5-2', 'pro', Date.parse('2026-11-17T07:59:58Z'))?.access).toBe('included');
    expect(claudePlanRule('claude-fable-5-2', 'pro', Date.parse('2026-11-17T07:59:59Z'))?.access).toBe('credits');
    expect(claudePlanRule('claude-fable-5-2', 'pro', AFTER_OFFER_ENDS)?.access).toBe('credits');
  });

  it('keeps Fable 5.1 on credits on Pro, and the offer off other versions', () => {
    expect(claudePlanRule('claude-fable-5-1', 'pro', BEFORE_OFFER_ENDS)?.access).toBe('credits');
    expect(claudePlanRule('claude-fable-5-20', 'pro', BEFORE_OFFER_ENDS)?.access).toBe('credits');
  });

  it('caps Fable on Max and Ultra, and reads the plan type loosely', () => {
    expect(claudePlanRule('claude-fable-5-2', 'max', AFTER_OFFER_ENDS)).toMatchObject({ access: 'capped', capPercent: 50 });
    expect(claudePlanRule('claude-fable-5-1', ' Ultra ', AFTER_OFFER_ENDS)?.access).toBe('capped');
    expect(claudePlanRule('claude-fable-5-1', 'free', AFTER_OFFER_ENDS)?.access).toBe('not-in-plan');
    expect(claudePlanRule('claude-fable-5-1', 'team', AFTER_OFFER_ENDS)?.access).toBe('seat');
  });

  it('says nothing for other models, unknown plans or an unread plan', () => {
    expect(claudePlanRule('claude-opus-5-5', 'pro', AFTER_OFFER_ENDS)).toBeNull();
    expect(claudePlanRule('opus', 'pro', AFTER_OFFER_ENDS)).toBeNull();
    expect(claudePlanRule('claude-fable-5-2', 'someday-plan', AFTER_OFFER_ENDS)).toBeNull();
    expect(claudePlanRule('claude-fable-5-2', null, AFTER_OFFER_ENDS)).toBeNull();
  });

  it('honours `from`, so a future change can ship ahead of its day', () => {
    const rules: ClaudePlanRule[] = [
      { family: 'fable', plans: ['pro'], access: 'included', from: '2027-01-01T00:00:00Z', source: 's', reviewedAt: '2026-11-10' },
      ...CLAUDE_PLAN_RULES,
    ];
    expect(claudePlanRule('claude-fable-5-1', 'pro', AFTER_OFFER_ENDS, rules)?.access).toBe('credits');
    expect(claudePlanRule('claude-fable-5-1', 'pro', Date.parse('2027-01-01T00:00:00Z'), rules)?.access).toBe('included');
  });

  it('every shipped rule names its source and a check date', () => {
    for (const r of CLAUDE_PLAN_RULES) {
      expect(r.source).toMatch(/^https:\/\//);
      expect(r.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('claudePlanNote', () => {
  it('labels each access for the picker', () => {
    expect(claudePlanNote('claude-fable-5-2', 'pro', BEFORE_OFFER_ENDS)?.label).toMatch(/^Included until /);
    expect(claudePlanNote('claude-fable-5-2', 'pro', AFTER_OFFER_ENDS)?.label).toBe('Uses usage credits');
    expect(claudePlanNote('claude-fable-5-2', 'max', AFTER_OFFER_ENDS)?.label).toBe('Up to 50% of weekly usage');
    expect(claudePlanNote('claude-fable-5-2', 'free', AFTER_OFFER_ENDS)?.label).toBe('Not in your plan');
    expect(claudePlanNote('claude-fable-5-2', 'enterprise', AFTER_OFFER_ENDS)?.label).toBe('Depends on your seat');
    expect(claudePlanNote('claude-sonnet-5-5', 'pro', AFTER_OFFER_ENDS)).toBeNull();
  });

  it('stops making a claim once a rule has gone unchecked too long', () => {
    const note = claudePlanNote('claude-fable-5-1', 'max', Date.parse('2027-02-01T00:00:00Z'));
    expect(note).toMatchObject({ access: 'unchecked', label: 'Check your plan' });
    expect(note?.detail).toContain('last checked');
  });
});

describe('claudePlanUsageNotice', () => {
  const base = { modelId: 'claude-fable-5-2', now: AFTER_OFFER_ENDS };

  it('warns when Claude Code reports the Fable window close to its cap', () => {
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: limits([fableWeek(86, 'warning')]) }))
      .toEqual({ kind: 'near-limit', text: "You're close to your Fable limit for this week (86% used)." });
  });

  it('says Fable moves onto credits once its window is spent and credits are on', () => {
    const spent = limits([fableWeek(100, 'rate_limited')], { creditsState: 'balance', creditsBalance: 12 });
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: spent })?.kind).toBe('on-credits');
    const unlimited = limits([fableWeek(100, 'rate_limited')], { creditsState: 'unlimited' });
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: unlimited })?.kind).toBe('on-credits');
  });

  it('leaves a spent window with no credits to the "Limit reached" block', () => {
    const none = limits([fableWeek(100, 'rate_limited')], { creditsState: 'disabled' });
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: none })).toBeNull();
    const empty = limits([fableWeek(100, 'rate_limited')], { creditsState: 'balance', creditsBalance: 0 });
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: empty })).toBeNull();
  });

  it('tells a Pro user every Fable message spends credits, from the catalog when nothing live says otherwise', () => {
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'pro' })?.kind).toBe('on-credits');
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'pro', now: BEFORE_OFFER_ENDS })).toBeNull();
  });

  it('keeps the catalog for a window that is fine, and lets a live warning win over it', () => {
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'pro', limits: limits([fableWeek(40, 'allowed')]) })?.kind).toBe('on-credits');
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'pro', limits: limits([fableWeek(90, 'warning')]) })?.kind).toBe('near-limit');
  });

  it('is quiet on other models and other windows', () => {
    expect(claudePlanUsageNotice({ ...base, modelId: 'claude-opus-5-5', subscriptionType: 'max', limits: limits([fableWeek(90, 'warning')]) })).toBeNull();
    const opus = { ...fableWeek(95, 'warning'), id: 'weekly-opus', modelFamily: 'opus' };
    expect(claudePlanUsageNotice({ ...base, subscriptionType: 'max', limits: limits([opus]) })).toBeNull();
  });
});
