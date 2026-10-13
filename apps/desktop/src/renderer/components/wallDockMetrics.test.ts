import { expect, it } from 'vitest';
import type { UsageSummary, SessionSummary, ProviderConfig } from '@nekko-agent/shared';
import { budgetRange, recordedBudgetMetrics, utilizationProviders } from './wallDockMetrics.js';
it('reports unavailable rather than zero when the usage snapshot is missing', () => {
  expect(recordedBudgetMetrics(null, [], [])).toEqual({ topAgent: 'Unavailable', localTokens: 'Unavailable' });
});
it('ranks recorded session tokens and counts only local provider totals', () => {
  const usage = { bySession: { a: { input: 5, output: 7 }, b: { input: 20, output: 10 } }, byProvider: { local: { input: 9, output: 11 }, cloud: { input: 100, output: 200 } } } as unknown as UsageSummary;
  const sessions = [{ id: 'b', title: 'Build UI' }] as SessionSummary[];
  const providers = [{ id: 'local', kind: 'ollama' }, { id: 'cloud', kind: 'openai' }] as ProviderConfig[];
  expect(recordedBudgetMetrics(usage, sessions, providers)).toEqual({ topAgent: 'Build UI · 30 tokens', localTokens: '20' });
});
it('sums Budget spend and tokens over the chosen Insights range', () => {
  const usage = { daily: [
    { date: '2026-10-08', input: 1, output: 2, cost: 0.5 },
    { date: '2026-10-03', input: 10, output: 20, cost: 1 },
    { date: '2026-01-01', input: 100, output: 200, cost: 5 },
  ] } as unknown as UsageSummary;
  const now = new Date('2026-10-08T09:00:00Z');
  expect(budgetRange(null, '1m', now)).toBeNull();
  expect(budgetRange(usage, 'today', now)).toMatchObject({ spend: 0.5, input: 1, output: 2 });
  expect(budgetRange(usage, '1wk', now)).toMatchObject({ spend: 1.5, input: 11, output: 22 });
  expect(budgetRange(usage, 'all-time', now)).toMatchObject({ spend: 6.5, input: 111, output: 222 });
});


it('ranges every budget detail, excludes future days and never falls back to lifetime totals', () => {
  const day = (date: string, n: number) => ({ date, input: n, output: n, cost: n, localTokens: n * 2, bySessionCost: { [date]: n }, modelIds: [date], avoidedCosts: { local: n, subscription: n * 2, benchmarkTokens: n * 3, unpricedTokens: n * 4 } });
  const usage = { daily: [day('2026-10-08', 1), day('2026-10-02', 10), day('2026-09-09', 100), day('2026-04-12', 1000), day('2025-10-09', 10000), day('2025-01-01', 100000), day('2026-10-09', 999999)] } as UsageSummary;
  const now = new Date('2026-10-08T23:59:59Z');
  const ranges = ['today', '1wk', '1m', '6m', '1y', 'all-time'] as const;
  ranges.forEach((range, i) => {
    const expected = [1, 11, 111, 1111, 11111, 111111][i];
    const result = budgetRange(usage, range, now)!;
    expect(result).toMatchObject({ spend: expected, input: expected, output: expected, localTokens: expected * 2, avoidedCosts: { local: expected, subscription: expected * 2, benchmarkTokens: expected * 3, unpricedTokens: expected * 4 } });
    expect(Object.values(result.bySessionCost!)).toHaveLength(i + 1);
    expect(Object.values(result.bySessionCost!).reduce((a, b) => a + b, 0)).toBe(expected);
    expect(result.modelIds).toHaveLength(i + 1);
  });
  expect(budgetRange({ daily: [{ date: '2026-10-08', input: 1, output: 1, cost: 1 }], avoidedCosts: { local: 999 } } as UsageSummary, 'today', now)).toMatchObject({ localTokens: null, avoidedCosts: null, bySessionCost: null });
});
it('prefers anthropic Claude subscription entries regardless of order without modifying configs', () => {
  const native = { id: 'native', enabled: true, kind: 'anthropic', auth: 'subscription', tokenKey: 'claude:a' } as ProviderConfig;
  const harness = { ...native, id: 'harness', kind: 'openai-compat' } as ProviderConfig;
  const other = { ...harness, id: 'other', tokenKey: 'claude:b' };
  const api = { ...native, id: 'api', auth: 'apikey' } as ProviderConfig;
  for (const pair of [[native, harness], [harness, native]]) {
    const providers = [...pair, other, api];
    expect(utilizationProviders(providers)).toEqual([native, other, api]);
    expect(providers).toHaveLength(4);
  }
  expect(utilizationProviders([{ ...native, enabled: false }, harness])).toEqual([harness]);
  expect(utilizationProviders([{ ...harness, tokenKey: undefined }, { ...native, tokenKey: undefined }])).toHaveLength(2);
});
