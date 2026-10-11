import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, LimitWindow, ProviderConfig, SubscriptionLimits, TurnStats } from '@nekko-agent/shared';
import { MODEL_PRICING, estimateCost } from '@nekko-agent/shared';
import { MODEL_PRICING_SNAPSHOT } from '../../shared/src/model-pricing-snapshot.js';
import { withDataDir } from './paths.js';
import { usageSummary } from './usage.js';
import { sideUsageRecord, turnReplyRecord, turnUsageRecord } from './usage-records.js';
import { quotaHistoryRecord } from './quota-history.js';
import {
  LimitsReadError,
  classifyLimitsError,
  describeAnthropicWindow,
  limitsBackoffMs,
  mergeWindows,
  parseAnthropicHeaders,
  parseAnthropicUsageJson,
  parseChatGptUsage,
  parseOpenRouterKey,
  parseRetryAfter,
} from './limits.js';

/**
 * What the usage and limits services produce, which the engine daemon's port
 * (crates/nekko-usage) must reproduce exactly: cost estimates, `usage:summary`
 * over real log files, the usage, reply and quota-history lines a turn writes,
 * and the limit parsers (Anthropic headers and usage JSON, ChatGPT, OpenRouter,
 * window merging, Retry-After, error classes and backoff). Also writes the price
 * tables the daemon embeds (crates/nekko-usage/src/pricing.json). Fails if
 * either file is stale; rewrite them with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-usage');

function check(path: string, actual: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

const NOW = 1_760_000_000_000;
afterEach(() => vi.useRealTimers());

/** A thrown limits error as the golden records it. */
function outcome<T>(f: () => T): T | { error: { kind: string; status?: number } } {
  try {
    return f();
  } catch (e) {
    if (e instanceof LimitsReadError) return { error: { kind: e.kind, status: e.status } };
    throw e;
  }
}

const MODELS = [
  'claude-sonnet-4-5', 'claude-opus-4-1-20250805', 'Claude-Haiku-5-5', 'claude-fable-5.1', 'claude-sonnet-5-5-latest',
  'qwen3:32b', 'qwen3:32b-q4', 'gpt-oss:20b', 'gpt-oss:120b_x', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1-codex',
  'gpt-6-astra', 'gpt-6-astra-2026-01-02', 'openai/gpt-6.1-sol', 'gpt-5-2025-08-07', 'gpt-7', 'o1-mini', 'o1', 'o3', 'o3-mini',
  'llama3', 'anthropic/claude-haiku-5.5', 'claude-haiku-5.5', 'stepfun/step-5-preview', 'step-5-preview', 'gemma-3-27b-it',
  'gpt-4o-mini-2024', 'GPT-4.1-NANO', 'gpt-4.1', 'gpt-3.5-turbo', 'unknown', 'x/qwen3-32b',
];

function costCases() {
  const usages = [
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 10 },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
    { inputTokens: 3, outputTokens: 7, cacheWriteTokens: 0 },
    { inputTokens: 1_000_000, outputTokens: 1_000_000, auth: 'subscription' as const },
  ];
  const out: Array<{ modelId: string; usage: unknown; output: number | null }> = [];
  for (const modelId of [...MODELS, '']) {
    for (const usage of usages) out.push({ modelId, usage, output: estimateCost(modelId, usage) ?? null });
  }
  return out;
}

const line = (r: unknown) => JSON.stringify(r);

/** Each summary fixture: the three files as text (absent when null), and what usage:summary returns. */
function summaryCases() {
  const day = (iso: string) => Date.parse(iso);
  const u = (r: Record<string, unknown>) => line({ ts: day('2026-10-01T12:00:00Z'), providerId: 'p', modelId: 'gpt-4o', inputTokens: 1000, outputTokens: 500, sessionId: 's1', ...r });
  const fixtures: Array<{ name: string; settings: string | null; usage: string | null; replies: string | null }> = [
    { name: 'nothing', settings: null, usage: null, replies: null },
    { name: 'empty log', settings: null, usage: '', replies: null },
    {
      name: 'api, subscription, local and cache',
      settings: line({ providers: [{ id: 'ol', kind: 'ollama' }, { id: 'p', kind: 'openai' }], localCostBenchmark: 'claude-sonnet' }),
      usage: [
        u({}),
        u({ modelId: 'claude-opus-4-1', auth: 'subscription', sessionId: 's2', cacheReadTokens: 2000, cacheWriteTokens: 300 }),
        u({ providerId: 'ol', modelId: 'llama3', sessionId: 's2', ts: day('2026-10-02T01:00:00Z') }),
        u({ modelId: 'llama3', local: true, sessionId: '' }),
        u({ modelId: 'claude-haiku', local: true, ts: day('2026-09-30T23:59:59.999Z') }),
        u({ modelId: 'gpt-4o', local: false, providerId: 'ol', cacheReadTokens: 0 }),
        u({ modelId: 'unknown-subscription', auth: 'subscription', sessionId: 's3' }),
        '',
        '   ',
        '{"torn":',
      ].join('\n') + '\n',
      replies: null,
    },
    {
      name: 'default benchmark and opting out',
      settings: line({ providers: [] }),
      usage: [u({ modelId: 'unlisted-local', local: true }), u({ modelId: 'qwen3:32b', local: true })].join('\n'),
      replies: null,
    },
    {
      name: 'benchmark switched off',
      settings: line({ providers: 'nope', localCostBenchmark: '' }),
      usage: [u({ modelId: 'unlisted-local', local: true }), u({ modelId: 'gpt-4o', auth: 'subscription' })].join('\n'),
      replies: null,
    },
    {
      name: 'odd records',
      settings: '{not json',
      usage: [
        line({ ts: 0, providerId: 'p', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 2, sessionId: 'a' }),
        line({ ts: null, modelId: 'gpt-4o', inputTokens: 1, outputTokens: 2 }),
        line({ ts: 1.9, providerId: 'p', modelId: 'claude-sonnet-4-5', inputTokens: null, outputTokens: 2, cacheReadTokens: null, sessionId: 'a' }),
        line({ ts: -86_400_001, providerId: 'p', inputTokens: 5, outputTokens: 5, sessionId: 'b' }),
        line({ ts: day('2026-10-03T00:00:00Z'), providerId: 'p', modelId: 'gpt-4o', outputTokens: 5, sessionId: 'b' }),
        line({ ts: day('2026-10-03T00:00:00Z'), providerId: 'p', modelId: 'gpt-4o', inputTokens: 5, outputTokens: 5, local: null, auth: 'apikey', sessionId: 'b' }),
        line({ ts: day('2026-10-03T00:00:00Z'), providerId: 'p', modelId: '0', inputTokens: 1, outputTokens: 1, sessionId: '7' }),
        line({ ts: day('2026-10-03T00:00:00Z'), providerId: 'p', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1, sessionId: 0 }),
        line({ ts: '2026-10-04T00:00:00Z', providerId: 'p', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1, sessionId: 'c' }),
        line({ ts: true, providerId: 'p', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1, sessionId: 'c' }),
      ].join('\n'),
      replies: null,
    },
    {
      name: 'replies',
      settings: null,
      usage: null,
      replies: [
        line({ ts: 5, sessionId: 's', providerId: 'p', modelId: 'm', steps: 3, stop: 'complete' }),
        line({ ts: 9, sessionId: 's', providerId: 'p', modelId: 'm', steps: 12, stop: 'loop' }),
        line({ ts: 7, sessionId: 't', providerId: 'p', modelId: 'n', steps: 0, stop: 'loop', maxSteps: 50 }),
        line({ ts: 8, sessionId: 't', providerId: 'p', modelId: 'n', steps: 40, stop: 'step_limit' }),
        line({ ts: 1, sessionId: 'u', providerId: 'p', modelId: 'n', steps: 2, stop: 'runaway' }),
        line({ ts: 2, sessionId: 'u', modelId: 'n', steps: 1, stop: 'loop' }),
        '{"torn',
        '',
        ...Array.from({ length: 11 }, (_, i) => line({ ts: 100 + i, sessionId: `r${i}`, providerId: 'p', modelId: 'm', steps: i + 1, stop: 'loop' })),
      ].join('\n') + '\n',
    },
    { name: 'replies, all blank', settings: null, usage: null, replies: '\n\n{bad\n' },
    {
      name: 'usage and replies together',
      settings: line({ providers: [{ id: 'p', kind: 'openai' }], localCostBenchmark: 'gpt-4o-mini' }),
      usage: [u({}), u({ ts: day('2025-01-01T00:00:00Z'), modelId: 'gpt-6.1-sol', auth: 'subscription', cacheReadTokens: 2_000_000 })].join('\n') + '\n',
      replies: line({ ts: 5, sessionId: 's', providerId: 'p', modelId: 'm', steps: 1, stop: 'complete', effort: 'normal', inputTokens: 1 }) + '\n',
    },
  ];
  return fixtures.map((f) => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-usage-golden-'));
    try {
      if (f.settings != null) writeFileSync(join(dir, 'settings.json'), f.settings);
      if (f.usage != null) writeFileSync(join(dir, 'usage.jsonl'), f.usage);
      if (f.replies != null) writeFileSync(join(dir, 'replies.jsonl'), f.replies);
      const output = withDataDir(dir, () => usageSummary());
      return { ...f, output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function recordCases() {
  const opts = { sessionId: 's_1', providerId: 'p', modelId: 'claude-sonnet-4-5' };
  const usage: Array<Extract<AgentEvent, { type: 'usage' }>> = [
    { type: 'usage', sessionId: 's_1', inputTokens: 10, outputTokens: 20 },
    { type: 'usage', sessionId: 's_1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
  ];
  const providers: Array<Pick<ProviderConfig, 'auth' | 'kind'>> = [
    { kind: 'anthropic', auth: 'subscription' },
    { kind: 'llamacpp' },
    { kind: 'openai', auth: 'apikey' },
  ];
  const usageLines = [];
  for (const event of usage) for (const provider of providers) {
    usageLines.push({ input: { opts, provider, event, ts: NOW }, output: line(turnUsageRecord(opts, provider, event, NOW)) });
  }
  const stats: TurnStats = { providerId: 'p', modelId: 'm', effort: 'high', inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0, outputMs: 120, wallMs: 400 } as TurnStats;
  const partial = { providerId: 'p', modelId: 'm', inputTokens: 5, outputTokens: 6, wallMs: 10 } as TurnStats;
  const done: Array<Extract<AgentEvent, { type: 'done' }>> = [
    { type: 'done', sessionId: 's_1', stop: 'complete', steps: 3 } as Extract<AgentEvent, { type: 'done' }>,
    { type: 'done', sessionId: 's_1', stop: 'loop' } as Extract<AgentEvent, { type: 'done' }>,
    { type: 'done', sessionId: 's_1' } as Extract<AgentEvent, { type: 'done' }>,
  ];
  const replyLines = [];
  for (const event of done) for (const finished of [stats, partial, undefined]) for (const incognito of [false, true]) {
    const rec = turnReplyRecord(opts, incognito, NOW - 500, event, finished, NOW);
    replyLines.push({ input: { opts, incognito, startedAt: NOW - 500, event, finished: finished ?? null, ts: NOW }, output: rec ? line(rec) : null });
  }
  const sideLines = [];
  for (const provider of [{ id: 'p', kind: 'llamacpp', auth: undefined }, { id: 'c', kind: 'anthropic', auth: 'subscription' }, {}])
    for (const item of [{ inputTokens: 10, outputTokens: 4 }, { cacheReadTokens: 3, cacheWriteTokens: 0 }, {}])
      for (const [modelId, sessionId] of [['m', 's_1'], [undefined, undefined]]) {
        const rec = sideUsageRecord(provider, modelId, sessionId, item, NOW);
        sideLines.push({ input: { provider, modelId: modelId ?? null, sessionId: sessionId ?? null, item, ts: NOW }, output: line(rec) });
      }
  return { usageLines, replyLines, sideLines };
}

const W = (id: string, label: string, scope: LimitWindow['scope'], extra: Partial<LimitWindow> = {}): LimitWindow => ({ id, label, scope, usedPercent: 10, resetAt: 1, status: 'allowed', ...extra });

function quotaCases() {
  const providers = [
    { id: 'claude', kind: 'anthropic', tokenKey: 'claude:a', enabled: true },
    { id: 'or', kind: 'openrouter', apiKey: 'k', enabled: true },
    { id: 'off', kind: 'openrouter', apiKey: 'k', enabled: false },
  ] as ProviderConfig[];
  const limits: SubscriptionLimits = { windows: [W('5h', '5-hour', 'session', { usedPercent: 12.5, resetAt: NOW + 1000 }), W('7d_opus', '7-day Opus', 'model', { modelFamily: 'opus', status: 'warning' })], planType: 'max', updatedAt: NOW, staleAfterMs: 60_000 };
  return [
    ['claude:a', 'headers'], ['claude:a', 'poll'], ['provider:or', 'poll'], ['provider:off', 'poll'], ['claude:b', 'headers'], ['provider:claude', 'poll'],
  ].map(([tokenKey, source]) => {
    const rec = quotaHistoryRecord(providers, tokenKey, source as 'poll', limits);
    return { input: { providers, tokenKey, source, limits }, output: rec ? line(rec) : null };
  });
}

function limitCases() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const P = 'anthropic-ratelimit-unified-';
  const headers: Array<Array<[string, string]>> = [
    [[`${P}5h-utilization`, '0.62'], [`${P}5h-reset`, '1760003600'], [`${P}5h-status`, 'allowed'], [`${P}7d-utilization`, '0.95'], [`${P}7d-status`, 'allowed_warning']],
    [[`${P}7d_opus-utilization`, '0.4'], [`${P}7d_fable-utilization`, '1.7'], [`${P}7d_fable-status`, 'rejected'], [`${P}5h-utilization`, '0.1']],
    [[`${P}weird-utilization`, '0.3'], [`${P}7d_claude_next-utilization`, '0.2abc'], [`${P}5h-utilization`, 'nope'], ['content-type', 'application/json']],
    [[`${P.toUpperCase()}5H-UTILIZATION`, '0.5'], [`${P}5h-reset`, 'x'], [`${P}-utilization`, '0.5'], [`${P}seven_day_sonnet-utilization`, '-0.2']],
    [[`${P}5h-utilization`, '0.123456'], [`${P}5h-utilization`, '0.5'], [`${P}5h-status`, 'RATE_LIMITED']],
    [],
  ];
  const usageJson: Array<Record<string, unknown>> = [
    { five_hour: { utilization: 62, resets_at: '2026-10-09T10:00:00.123456+00:00' }, seven_day: { utilization: '85', resets_at: '2026-10-12T00:00:00Z' }, seven_day_opus: { utilization: 100 }, extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5 } },
    { seven_day_fable: { utilization: 4.567, status: 'warning' }, five_hour: null, extra_usage: { is_enabled: false } },
    { five_hour: { utilization: 'x' }, seven_day: { utilization: null, resets_at: 5 }, '7d_sonnet': { utilization: 79.999 }, extra_usage: { monthly_limit: '20' }, iguana_necktie: { utilization: 3 }, extra: 5 },
    { five_hour: { utilization: 200, status: 'rejected' }, extra_usage: { monthly_limit: 'x' } },
    { seven_day: { utilization: [7] }, five_hour: { utilization: true }, extra_usage: 'no' },
    {},
  ];
  const chatgpt: Array<Record<string, unknown>> = [
    { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 42, reset_at: 1_760_003_600, limit_window_seconds: 18_000 }, secondary_window: { used_percent: '81.5', reset_at: 1_760_500_000, limit_window_seconds: 604_800 } }, credits: { balance: '12.50' } },
    { rate_limit: { allowed: false, primary_window: { used_percent: 10, limit_window_seconds: 86_400 }, secondary_window: { used_percent: 'x' } }, credits: { unlimited: true } },
    { rate_limit: { allowed: true, limit_reached: true, primary_window: { used_percent: 5, limit_window_seconds: 90 }, secondary_window: { used_percent: 99, limit_window_seconds: 1_209_600 } }, credits: { balance: 3 } },
    { rate_limit: { allowed: true, primary_window: { used_percent: 150, limit_window_seconds: 1.5 } }, credits: {} },
    { plan_type: 5 },
  ];
  const openrouter: unknown[] = [
    { data: { limit: 10, usage: 2.5, is_free_tier: false } },
    { data: { limit: null, limit_remaining: null, is_free_tier: true, free_model_daily_requests: { limit: 50, remaining: 10 } } },
    { data: { limit: 5, limit_remaining: 1, free_model_daily_requests: { limit: 50, used: 45 } } },
    { data: { limit: 5, usage: 9, free_model_daily_requests: { limit: 0 } } },
    { data: { free_model_daily_requests: { limit: 10, used: 10 } } },
    {},
    undefined,
  ];
  const merge: Array<[LimitWindow[], LimitWindow[]]> = [
    [[W('7d_fable', '7-day Fable', 'model'), W('5h', '5-hour', 'session'), W('7d', '7-day', 'weekly')], [W('5h', '5-hour', 'session', { usedPercent: 50 })]],
    [[], [W('7d_opus', '7-day Opus', 'model'), W('7d_fable', '7-day Fable', 'model'), W('7d_Zed', '7-day Zed', 'model'), W('7d_alpha', '7-day alpha', 'model'), W('weird', 'weird', 'weekly'), W('5h', '5-hour', 'session')]],
  ];
  const retryAfter: Array<string | null | undefined> = ['120', '0', '1.5', '-0', 'Fri, 10 Oct 2025 12:00:00 GMT', 'Sat, 10 Oct 2026 08:53:30 GMT', 'soon', '', null, undefined, ' 30 '];
  const errors = [
    new LimitsReadError('rate_limited', 429, 5000), new LimitsReadError('http', 500), new LimitsReadError('auth_expired', 401),
    new Error('Subscription session expired for x. Sign in again.'), new Error('No subscription token found for k. Sign in again.'),
    new Error('No subscription token found'), new Error('Token refresh failed (400)'), new Error('invalid_grant'), new Error('fetch failed'), 'a string',
    new Error('Token was REVOKED'),
  ];
  return {
    headers: headers.map((input) => ({ input, output: parseAnthropicHeaders(input) })),
    usageJson: usageJson.map((input) => ({ input, output: parseAnthropicUsageJson(input) })),
    chatgpt: chatgpt.map((input) => ({ input, output: parseChatGptUsage(input) })),
    openrouter: openrouter.map((input) => ({ input: input ?? null, output: outcome(() => parseOpenRouterKey(input, 200)) })),
    merge: merge.map(([previous, fresh]) => ({ input: { previous, fresh }, output: mergeWindows(previous, fresh) })),
    retryAfter: retryAfter.map((input) => ({ input: input ?? null, output: parseRetryAfter(input, NOW) ?? null })),
    classify: errors.map((e) => ({ input: e instanceof LimitsReadError ? { limits: e.kind, status: e.status ?? null, retryAfterMs: e.retryAfterMs ?? null } : { message: e instanceof Error ? e.message : String(e) }, output: classifyLimitsError(e) })),
    backoff: [[1], [2], [3], [6], [7], [20], [0], [1, 5_000_000], [2, 10]].map(([failures, retry]) => ({ input: { failures, retryAfterMs: retry ?? null }, output: limitsBackoffMs(failures, retry) })),
    describe: [['5h', undefined], ['7d', 'opus'], ['7d', 'claude_next'], ['weird', undefined], ['weird', 'x-y'], ['5h', 'fable']].map(([period, family]) => ({ input: { period, family: family ?? null }, output: describeAnthropicWindow(period!, family) })),
  };
}

it('the usage and limits services match the daemon golden set', () => {
  check(join(crate, 'src', 'pricing.json'), { family: MODEL_PRICING, published: MODEL_PRICING_SNAPSHOT.models });
  const records = recordCases();
  check(join(crate, 'tests', 'golden', 'expected.json'), {
    now: NOW,
    costs: costCases(),
    summaries: summaryCases(),
    usageLines: records.usageLines,
    replyLines: records.replyLines,
    sideLines: records.sideLines,
    quota: quotaCases(),
    limits: limitCases(),
  });
});
