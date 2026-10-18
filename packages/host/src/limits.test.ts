import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataDir } from './paths.js';
import { setToken } from './oauth.js';
import { saveSettings } from './store.js';
import { initLimits, recordFromHeaders, poll, get, getLimits } from './limits.js';
import { limitsKeyFor } from '@nekko-agent/shared';

const TEST_NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LimitsService header capture', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
  });

  it('emits a normalized snapshot from Anthropic response headers', () => {
    const events = new EventEmitter();
    const emitted: Array<{ tokenKey: string; limits: import('@nekko-agent/shared').SubscriptionLimits }> = [];
    events.on('limitsUpdated', (e) => emitted.push(e));
    initLimits(events);

    const headers = new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': '1900000000',
      'anthropic-ratelimit-unified-7d-status': 'warning',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.05',
      'anthropic-ratelimit-unified-7d_sonnet-reset': '1850000000',
      'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
      'anthropic-ratelimit-unified-7d_opus-utilization': '0.0',
      'anthropic-ratelimit-unified-7d_opus-reset': '0',
      'anthropic-ratelimit-unified-7d_opus-status': 'allowed',
    });

    const limits = recordFromHeaders('claude:acct-1', 'anthropic', headers);
    expect(limits).toBeTruthy();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tokenKey).toBe('claude:acct-1');

    const state = get('claude:acct-1');
    expect(state).toBeTruthy();
    expect(state!.windows).toHaveLength(4);

    const fiveHour = state!.windows.find((w) => w.id === '5h');
    expect(fiveHour).toMatchObject({
      id: '5h',
      scope: 'session',
      usedPercent: 35,
      resetAt: 1_800_000_000_000,
      status: 'allowed',
    });

    const sevenDay = state!.windows.find((w) => w.id === '7d');
    expect(sevenDay).toMatchObject({
      id: '7d',
      scope: 'weekly',
      usedPercent: 12,
      resetAt: 1_900_000_000_000,
      status: 'warning',
    });

    const sonnetWindow = state!.windows.find((w) => w.id === '7d_sonnet');
    expect(sonnetWindow).toMatchObject({
      id: '7d_sonnet',
      scope: 'model',
      modelFamily: 'sonnet',
      usedPercent: 5,
    });
  });

  it('picks up a per-model header window it was never told about', () => {
    initLimits(new EventEmitter());
    const limits = recordFromHeaders(
      'claude:acct-fable-headers',
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-7d-utilization': '0.10',
        'anthropic-ratelimit-unified-7d-reset': '1900000000',
        'anthropic-ratelimit-unified-7d_fable-utilization': '0.66',
        'anthropic-ratelimit-unified-7d_fable-reset': '1850000000',
        'anthropic-ratelimit-unified-7d_fable-status': 'warning',
      }),
    );

    expect(limits!.windows.find((w) => w.id === '7d_fable')).toMatchObject({
      label: '7-day Fable',
      scope: 'model',
      modelFamily: 'fable',
      usedPercent: 66,
      status: 'warning',
      resetAt: 1_850_000_000_000,
    });
  });

  it('keeps a per-model window the response headers say nothing about', () => {
    // Why the Fable limit "did not show up": the usage poll discovers
    // `7d_fable`, but a response's rate-limit headers only carry the windows
    // that request was billed against (`5h`, `7d`). Replacing the window list
    // with the header list therefore deleted the per-model windows on the very
    // next message, so the limit appeared once and then vanished.
    initLimits(new EventEmitter());
    const tokenKey = 'claude:acct-fable-merge';

    const polled = recordFromHeaders(
      tokenKey,
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-7d_fable-utilization': '0.42',
        'anthropic-ratelimit-unified-7d_fable-reset': '1850000000',
        'anthropic-ratelimit-unified-7d_fable-status': 'allowed',
      }),
    );
    expect(polled!.windows.map((w) => w.id)).toEqual(['7d_fable']);

    // A later turn reports only the account-wide windows.
    const after = recordFromHeaders(
      tokenKey,
      'anthropic',
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.20',
        'anthropic-ratelimit-unified-5h-reset': '1800000000',
        'anthropic-ratelimit-unified-7d-utilization': '0.10',
        'anthropic-ratelimit-unified-7d-reset': '1900000000',
      }),
    );

    expect(after!.windows.map((w) => w.id)).toEqual(['5h', '7d', '7d_fable']);
    expect(after!.windows.find((w) => w.id === '7d_fable')).toMatchObject({
      label: '7-day Fable',
      usedPercent: 42,
    });
  });

  it('lets a fresher header window replace its older namesake', () => {
    initLimits(new EventEmitter());
    const tokenKey = 'claude:acct-window-refresh';

    recordFromHeaders(tokenKey, 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.20',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
    }));
    const after = recordFromHeaders(tokenKey, 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.80',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'warning',
    }));

    expect(after!.windows).toHaveLength(1);
    expect(after!.windows[0]).toMatchObject({ id: '5h', usedPercent: 80, status: 'warning' });
  });

  it('normalizes rate_limited and rejected statuses', () => {
    initLimits(new EventEmitter());
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'rate_limited',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
      'anthropic-ratelimit-unified-7d-reset': '1900000000',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
    });
    const limits = recordFromHeaders('claude:acct-2', 'anthropic', headers)!;
    expect(limits.windows[0].status).toBe('rate_limited');
    expect(limits.windows[1].status).toBe('rate_limited');
  });

  it('leaves existing state unchanged when no recognized headers are present', () => {
    initLimits(new EventEmitter());
    const first = recordFromHeaders('claude:acct-3', 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    expect(first).toBeTruthy();

    const second = recordFromHeaders('claude:acct-3', 'anthropic', new Headers({ 'content-type': 'application/json' }));
    expect(second).toEqual(first);
    expect(get('claude:acct-3')).toEqual(first);
  });
});

describe('LimitsService ChatGPT /wham/usage poll', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('parses the verified ChatGPT payload shape', async () => {
    const tokenKey = 'chatgpt:acct-1';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-1',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1778670307 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: 1779157165 },
      },
      credits: { has_credits: false, unlimited: false, balance: '0' },
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer chatgpt-access');
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe('acct-1');

    expect(limits).toBeTruthy();
    expect(limits!.planType).toBe('plus');
    expect(limits!.creditsBalance).toBe(0);
    expect(limits!.windows).toHaveLength(2);

    const primary = limits!.windows.find((w) => w.id === '5h');
    expect(primary).toMatchObject({
      id: '5h',
      scope: 'session',
      usedPercent: 55,
      resetAt: 1_778_670_307_000,
      status: 'allowed',
    });

    const secondary = limits!.windows.find((w) => w.id === '7d');
    expect(secondary).toMatchObject({
      id: '7d',
      scope: 'weekly',
      usedPercent: 51,
      resetAt: 1_779_157_165_000,
      status: 'allowed',
    });
  });

  it.each([
    { name: 'weekly primary with null secondary', primary: 604800, secondary: null, expected: [['7d', '7-day', 'weekly']] },
    { name: 'weekly primary with absent secondary', primary: 604800, secondary: undefined, expected: [['7d', '7-day', 'weekly']] },
    { name: 'swapped weekly and session slots', primary: 604800, secondary: 18000, expected: [['7d', '7-day', 'weekly'], ['5h', '5-hour', 'session']] },
    { name: 'secondary only', primary: null, secondary: 18000, expected: [['5h', '5-hour', 'session']] },
    { name: 'other reported durations', primary: 3600, secondary: 86400, expected: [['1h', '1-hour', 'session'], ['1d', '1-day', 'session']] },
    { name: 'minute and second durations', primary: 300, secondary: 90, expected: [['5m', '5-minute', 'session'], ['90s', '90-second', 'session']] },
    { name: 'longer reported duration', primary: 2592000, secondary: null, expected: [['30d', '30-day', 'weekly']] },
    { name: 'missing durations', primary: undefined, secondary: undefined, expected: [['primary', 'Primary usage', 'session'], ['secondary', 'Secondary usage', 'session']] },
    { name: 'non-positive durations', primary: 0, secondary: -604800, expected: [['primary', 'Primary usage', 'session'], ['secondary', 'Secondary usage', 'session']] },
    { name: 'malformed durations', primary: '604800', secondary: '18000junk', expected: [['primary', 'Primary usage', 'session'], ['secondary', 'Secondary usage', 'session']] },
    { name: 'non-integer durations', primary: 18000.5, secondary: 1e100, expected: [['primary', 'Primary usage', 'session'], ['secondary', 'Secondary usage', 'session']] },
  ])('uses duration rather than slot: $name', async ({ primary, secondary, expected, name }) => {
    const tokenKey = 'chatgpt:duration-test';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accountId: 'duration-test',
      accessToken: 'chatgpt-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });
    const window = (duration: unknown, used: number, reset: number) => duration === null
      ? null
      : { used_percent: used, limit_window_seconds: duration, reset_at: reset, reset_after_seconds: 60 };
    const payload = {
      plan_type: 'free',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: window(primary, 55, 1778670307),
        // Missing duration is distinct from an absent window.
        secondary_window: name === 'weekly primary with absent secondary'
          ? undefined
          : window(secondary, 85, 1779157165),
      },
      credits: { unlimited: false, balance: '12.5' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    initLimits(new EventEmitter());

    const limits = await poll(tokenKey);
    expect(limits).toMatchObject({ planType: 'free', creditsBalance: 12.5, creditsState: 'balance' });
    expect(limits!.windows.map((w) => [w.id, w.label, w.scope])).toEqual(expected);
    const reported = [payload.rate_limit.primary_window, payload.rate_limit.secondary_window].filter((w) => w != null);
    expect(limits!.windows.map((w) => [w.usedPercent, w.resetAt, w.status])).toEqual(
      reported.map((w) => [w.used_percent, w.reset_at * 1000, w.used_percent >= 80 ? 'warning' : 'allowed']),
    );
  });

  it('throttles to one network call within 30 seconds', async () => {
    const tokenKey = 'chatgpt:acct-2';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-2',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1778670307 },
          secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1779157165 },
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(15_000);
    const second = await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second).toBeTruthy();

    vi.advanceTimersByTime(20_000);
    await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('emits limitsUpdated when a poll returns new state', async () => {
    const tokenKey = 'chatgpt:acct-3';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-3',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1778670307 },
          secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1779157165 },
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const events = new EventEmitter();
    const emitted: Array<{ tokenKey: string; limits: import('@nekko-agent/shared').SubscriptionLimits }> = [];
    events.on('limitsUpdated', (e) => emitted.push(e));
    initLimits(events);

    await poll(tokenKey);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tokenKey).toBe(tokenKey);
  });
});

describe('LimitsService Claude /api/oauth/usage poll', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('parses the verified usage API JSON shape', async () => {
    const tokenKey = 'claude:acct-4';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    // `utilization` here is whole percent (85 = 85%), unlike the rate-limit
    // headers, which report the same quantity as a fraction.
    const payload = {
      five_hour: { utilization: 85, status: 'allowed', resets_at: '2026-04-11T07:00:00.528743+00:00' },
      seven_day: { utilization: 13, status: 'allowed', resets_at: '2026-04-17T00:59:59.951713+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 100, status: 'allowed', resets_at: '2026-04-16T03:00:00.951719+00:00' },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer claude-access');
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20');

    expect(limits).toBeTruthy();
    expect(limits!.windows).toHaveLength(3); // opus window is null
    expect(limits!.windows.find((w) => w.id === '5h')).toMatchObject({ usedPercent: 85, status: 'warning' });
    expect(limits!.windows.find((w) => w.id === '7d')).toMatchObject({ usedPercent: 13, status: 'allowed' });
    expect(limits!.windows.find((w) => w.id === '7d_sonnet')).toMatchObject({ usedPercent: 100, status: 'rate_limited' });
  });

  it('reports a model window this build has never heard of', async () => {
    // Why the Fable window was missing: the parser walked a hard-coded list of
    // window names, so a family Anthropic added after the build simply had
    // nowhere to land.
    const tokenKey = 'claude:acct-fable';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      five_hour: { utilization: 10, status: 'allowed', resets_at: '2026-04-11T07:00:00Z' },
      seven_day: { utilization: 20, status: 'allowed', resets_at: '2026-04-17T00:59:59Z' },
      seven_day_fable: { utilization: 42, status: 'allowed', resets_at: '2026-04-16T03:00:00Z' },
      seven_day_mythos: { utilization: 5, status: 'allowed', resets_at: '2026-04-16T03:00:00Z' },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    expect(limits!.windows.map((w) => w.id)).toEqual(['5h', '7d', '7d_fable', '7d_mythos']);
    expect(limits!.windows.find((w) => w.id === '7d_fable')).toMatchObject({
      label: '7-day Fable',
      scope: 'model',
      modelFamily: 'fable',
      usedPercent: 42,
    });
    // `extra_usage` sits alongside the windows and carries a null utilization;
    // it is a credit block, not a window.
    expect(limits!.windows.some((w) => w.id.includes('extra'))).toBe(false);
  });

  it('reads the usage endpoint as whole percent, not as a fraction', async () => {
    const tokenKey = 'claude:acct-5';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        five_hour: { utilization: 0, status: 'allowed', resets_at: '2026-04-11T07:00:00.000000+00:00' },
        seven_day: { utilization: 62, status: 'allowed', resets_at: '2026-04-17T00:59:59.000000+00:00' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    // The bug this pins: 62 was multiplied by 100 and rendered as "6200%".
    expect(limits!.windows.find((w) => w.id === '7d')).toMatchObject({ usedPercent: 62, status: 'allowed' });
    expect(limits!.windows.find((w) => w.id === '5h')).toMatchObject({ usedPercent: 0, status: 'allowed' });
  });

  it('clamps an out-of-range percentage instead of rendering it', async () => {
    const tokenKey = 'claude:acct-6';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        seven_day: { utilization: 6200, status: 'allowed', resets_at: '2026-04-17T00:59:59.000000+00:00' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);
    expect(limits!.windows[0]).toMatchObject({ usedPercent: 100, status: 'rate_limited' });
  });
});

describe('LimitsService API-key provider read', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  const openRouterPayload = {
    data: {
      label: 'sk-or-test',
      limit: 100,
      limit_remaining: 74.5,
      usage: 25.5,
      usage_daily: 1.2,
      is_free_tier: false,
      free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
    },
  };

  it('polls an OpenRouter API-key provider through its inference key', async () => {
    saveSettings({
      providers: [{
        id: 'or-1', kind: 'openrouter', label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-or-test', enabled: true,
      }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(openRouterPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const events = new EventEmitter();
    const emitted: Array<{ tokenKey: string }> = [];
    events.on('limitsUpdated', (e) => emitted.push(e));
    initLimits(events);

    const limits = await poll('provider:or-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');

    expect(limits).toBeTruthy();
    expect(limits!.creditsBalance).toBe(74.5);
    expect(limits!.creditsState).toBe('balance');
    expect(limits!.windows.find((w) => w.id === 'free_daily')).toMatchObject({ usedPercent: 6 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tokenKey).toBe('provider:or-1');
    expect(get('provider:or-1')).toEqual(limits);
  });

  it('returns undefined without fetching for a provider id that is not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    initLimits(new EventEmitter());
    const limits = await poll('provider:ghost');
    expect(limits).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch for an API-key kind with no documented usage read', async () => {
    // OpenAI's usage API needs a separate org admin key, which is not the key
    // configured for inference; reading it would be unauthorized, so the
    // service must decline rather than guess.
    saveSettings({
      providers: [{
        id: 'oai-1', kind: 'openai', label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', enabled: true,
      }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    initLimits(new EventEmitter());
    const limits = await poll('provider:oai-1');
    expect(limits).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limitsKeyFor assigns keys only where an authorized read exists', () => {
    const base = { label: 'p', baseUrl: 'https://x', enabled: true };
    expect(limitsKeyFor({ ...base, id: 'a', kind: 'openai', apiKey: 'sk' })).toBeNull();
    expect(limitsKeyFor({ ...base, id: 'b', kind: 'openrouter', apiKey: 'sk-or' })).toBe('provider:b');
    expect(limitsKeyFor({ ...base, id: 'c', kind: 'openrouter' })).toBeNull();
    // Anthropic API keys report their own rate limits on each response.
    expect(limitsKeyFor({ ...base, id: 'f', kind: 'anthropic', apiKey: 'sk-ant' })).toBe('provider:f');
    expect(limitsKeyFor({ ...base, id: 'g', kind: 'anthropic' })).toBeNull();
    expect(limitsKeyFor({ ...base, id: 'd', kind: 'openai', auth: 'subscription', tokenKey: 'chatgpt:1' }))
      .toBe('chatgpt:1');
    expect(limitsKeyFor({ ...base, id: 'e', kind: 'openai', auth: 'subscription' })).toBeNull();
  });
});

describe('getLimits', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('returns fresh state without a network call', async () => {
    initLimits(new EventEmitter());
    recordFromHeaders('claude:fresh', 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const limits = await getLimits('claude:fresh');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limits).toBeTruthy();
    expect(limits!.windows).toHaveLength(1);
  });

  it('explicit refresh polls a fresh snapshot but retains provider throttling', async () => {
    const key = 'chatgpt:manual-refresh';
    setToken(key, { provider: 'chatgpt', accessToken: 'synthetic', accountId: 'manual', expiresAt: Date.now() + 120000, obtainedAt: Date.now() });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1778670307 } } }), { status: 200 }));
    initLimits(new EventEmitter());
    await getLimits(key);
    fetchMock.mockClear();
    await getLimits(key);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(31000);
    await getLimits(key, true);
    expect(fetchMock).toHaveBeenCalledOnce();
    await getLimits(key, true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('polls when the stored state is stale', async () => {
    const tokenKey = 'chatgpt:stale';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'stale',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1778670307 },
        secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1779157165 },
      },
      credits: { has_credits: false, unlimited: false, balance: '0' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    await getLimits(tokenKey);
    const state = get(tokenKey);
    expect(state).toBeTruthy();
    expect(state!.windows).toHaveLength(2);
  });
});

describe('plan and credits survive a chat turn', () => {
  it('keeps plan and credits when rate-limit headers update the windows', async () => {
    // The bug this covers: the usage poll supplies plan and credits, the
    // response headers supply only windows, and writing the headers over the
    // snapshot dropped both. The popover showed them once, then lost them the
    // moment the user sent a message.
    const tokenKey = 'claude:acct-merge';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10, status: 'allowed', resets_at: '2026-04-11T07:00:00Z' },
          extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    initLimits(new EventEmitter());
    const polled = await poll(tokenKey);
    expect(polled!.creditsBalance).toBe(37.5);
    expect(polled!.creditsState).toBe('balance');

    const afterHeaders = recordFromHeaders(tokenKey, 'claude', {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    });

    expect(afterHeaders!.windows.find((w) => w.id === '5h')!.usedPercent).toBe(42);
    expect(afterHeaders!.creditsBalance).toBe(37.5);
    expect(afterHeaders!.creditsState).toBe('balance');
  });
});

describe('anthropic credits', () => {
  const pollWith = async (payload: Record<string, unknown>) => {
    const tokenKey = `claude:acct-${Math.random().toString(36).slice(2)}`;
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    initLimits(new EventEmitter());
    return poll(tokenKey);
  };

  const base = { five_hour: { utilization: 1, status: 'allowed', resets_at: '2026-04-11T07:00:00Z' } };

  it('reads the extra-usage allowance as a remaining balance', async () => {
    const limits = await pollWith({ ...base, extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 30 } });
    expect(limits!.creditsBalance).toBe(70);
    expect(limits!.creditsState).toBe('balance');
  });

  it('counts an untouched allowance as its whole limit', async () => {
    const limits = await pollWith({ ...base, extra_usage: { is_enabled: true, monthly_limit: 20, used_credits: null } });
    expect(limits!.creditsBalance).toBe(20);
  });

  it('says extra usage is off rather than calling it unlimited', async () => {
    // The real payload for a plan without extra usage, which used to render as
    // "Credits: Unlimited".
    const limits = await pollWith({
      ...base,
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    });
    expect(limits!.creditsState).toBe('disabled');
    expect(limits!.creditsBalance).toBeUndefined();
  });

  it('says unknown when the payload carries no credit block at all', async () => {
    const limits = await pollWith(base);
    expect(limits!.creditsState).toBe('unknown');
  });

  it('never reports a negative balance when usage has overrun the limit', async () => {
    const limits = await pollWith({ ...base, extra_usage: { is_enabled: true, monthly_limit: 10, used_credits: 14 } });
    expect(limits!.creditsBalance).toBe(0);
  });
});
