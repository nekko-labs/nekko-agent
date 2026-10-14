import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUSD } from '@nekko-agent/shared';
import { withDataDir, setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { recordUsage, usageSummary } from './usage.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function setup() {
  root = mkdtempSync(join(tmpdir(), 'nekko-savings-'));
  setDataDir(root);
  saveSettings({ providers: [], localCostBenchmark: 'claude-sonnet' });
}
function record(modelId: string, extra = {}) {
  recordUsage({ ts: Date.now(), providerId: 'p', sessionId: 's', modelId, inputTokens: 1_000_000, outputTokens: 1_000_000, ...extra });
}

it('keeps API spend, subscription avoidance and local avoidance separate', () => {
  setup();
  record('claude-opus', { auth: 'subscription' });
  record('llama3', { local: true });
  record('gpt-4o');
  const summary = usageSummary();
  expect(summary.totalCost).toBe(12.5);
  expect(summary.avoidedCosts).toEqual({ subscription: 30, local: 18, benchmarkTokens: 2_000_000, unpricedTokens: 0 });
  expect(summary.bySessionAvoidedCosts?.s).toEqual(summary.avoidedCosts);
});

it('prefers exact model prices, excludes unknown subscription prices, and reprices benchmarks', () => {
  setup();
  record('claude-haiku', { local: true });
  record('llama3', { local: true });
  record('unknown-subscription', { auth: 'subscription' });
  saveSettings({ localCostBenchmark: 'gpt-4o-mini' });
  expect(usageSummary().avoidedCosts).toEqual({ subscription: 0, local: 6.75, benchmarkTokens: 2_000_000, unpricedTokens: 2_000_000 });
  saveSettings({ localCostBenchmark: '' });
  expect(usageSummary().avoidedCosts?.unpricedTokens).toBe(4_000_000);
});

it('infers locality for old records but respects recorded locality after provider changes', () => {
  setup();
  saveSettings({ providers: [{ id: 'p', name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434' }] });
  record('llama3');
  record('gpt-4o', { local: false });
  expect(usageSummary().totalCost).toBe(12.5);
  expect(usageSummary().avoidedCosts?.local).toBe(18);
});

it('uses the published local cloud fallback by default and lets users opt out', () => {
  root = mkdtempSync(join(tmpdir(), 'nekko-savings-'));
  setDataDir(root);
  saveSettings({ providers: [] });
  record('unlisted-local-model', { local: true });
  record('qwen3:32b', { local: true });
  const summary = usageSummary();
  expect(summary.totalCost).toBe(0);
  expect(summary.avoidedCosts?.local).toBeCloseTo(0.72);
  expect(summary.avoidedCosts?.benchmarkTokens).toBe(2_000_000);
  expect(summary.avoidedCosts?.unpricedTokens).toBe(0);
  saveSettings({ localCostBenchmark: '' });
  expect(usageSummary().avoidedCosts?.local).toBeCloseTo(0.36);
  expect(usageSummary().avoidedCosts?.unpricedTokens).toBe(2_000_000);
});

it('counts and prices persisted cache tokens separately', () => {
  setup();
  record('claude-sonnet', { outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
  const s = usageSummary();
  expect(s.totalInput).toBe(3_000_000);
  expect(s.totalCacheRead).toBe(1_000_000);
  expect(s.totalCacheWrite).toBe(1_000_000);
  expect(s.totalCost).toBeCloseTo(7.05);
  expect(s.bySession.s.listCost).toBeCloseTo(7.05);
  expect(s.daily[0].input).toBe(3_000_000);
});

describe('usageSummary', () => {
  it('prices subscription usage at list prices per session without billing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-usage-'));
    try {
      withDataDir(dir, () => {
        const model = 'claude-sonnet-4-5';
        recordUsage({ ts: 1, providerId: 'p', modelId: model, inputTokens: 1_000_000, outputTokens: 100_000, sessionId: 's', auth: 'subscription' });
        recordUsage({ ts: 2, providerId: 'q', modelId: model, inputTokens: 1_000, outputTokens: 1_000, sessionId: 's' });
        const s = usageSummary().bySession.s;
        const sub = estimateCostUSD(model, 1_000_000, 100_000);
        const metered = estimateCostUSD(model, 1_000, 1_000);
        expect(sub).toBeGreaterThan(0);
        expect(s.cost).toBeCloseTo(metered);
        expect(s.listCost).toBeCloseTo(sub + metered);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


it('sums all historical subscription records and caches without filtering dates or billing them', () => {
  setup();
  record('gpt-6.1-sol', { ts: Date.parse('2025-01-01'), sessionId: 'old', auth: 'subscription', outputTokens: 100_000, cacheReadTokens: 2_000_000 });
  record('gpt-6-astra', { sessionId: 'new', auth: 'subscription', outputTokens: 100_000 });
  record('gpt-6-sol', { auth: 'subscription' });
  const summary = usageSummary();
  expect(summary.avoidedCosts?.subscription).toBeCloseTo(30.2);
  expect(summary.avoidedCosts?.unpricedTokens).toBe(0);
  expect(summary.totalCost).toBe(0);
  expect(Object.values(summary.bySessionAvoidedCosts ?? {}).reduce((sum, v) => sum + v.subscription, 0)).toBeCloseTo(30.2);
});

it('records daily budget details with cache tokens and recorded locality across provider changes', () => {
  setup();
  record('llama3', { ts: Date.parse('2026-10-08T00:00:00Z'), local: true, cacheReadTokens: 10 });
  record('claude-opus', { ts: Date.parse('2026-10-08T23:59:59Z'), auth: 'subscription' });
  record('gpt-4o', { ts: Date.parse('2026-10-09T00:00:00Z'), sessionId: 'api' });
  saveSettings({ providers: [{ id: 'p', kind: 'openai', baseUrl: '', label: 'Changed', enabled: true }] });
  const summary = usageSummary();
  expect(summary.daily).toHaveLength(2);
  expect(summary.daily[0]).toMatchObject({ date: '2026-10-08', input: 2_000_010, output: 2_000_000, cost: 0, localTokens: 2_000_010, bySessionCost: { s: 0 }, modelIds: ['llama3', 'claude-opus'] });
  expect(summary.daily[0].avoidedCosts?.local).toBeGreaterThan(18);
  expect(summary.daily[0].avoidedCosts?.subscription).toBe(30);
  expect(summary.daily[0].avoidedCosts?.benchmarkTokens).toBe(2_000_010);
  expect(summary.daily[1]).toMatchObject({ localTokens: 0, bySessionCost: { api: 12.5 }, modelIds: ['gpt-4o'], avoidedCosts: { local: 0, subscription: 0 } });
});
