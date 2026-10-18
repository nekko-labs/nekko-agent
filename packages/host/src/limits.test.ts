import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataDir } from './paths.js';
import { setToken } from './oauth.js';
import { saveSettings } from './store.js';
import { initLimits, poll, get, getLimits } from './limits.js';
import { limitsKeyFor } from '@nekko-agent/shared';

const TEST_NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.restoreAllMocks();
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

describe('a Claude sign-in left by an older build', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('is never polled: Claude plan limits have no sanctioned source', async () => {
    const tokenKey = 'claude:old';
    setToken(tokenKey, { provider: 'claude', accessToken: 'old', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    initLimits(new EventEmitter());
    expect(await poll(tokenKey)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
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
    const key = 'chatgpt:fresh';
    setToken(key, { provider: 'chatgpt', accessToken: 'synthetic', accountId: 'fresh', expiresAt: Date.now() + 120000, obtainedAt: Date.now() });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1778670307 } } }), { status: 200 }));
    initLimits(new EventEmitter());
    await getLimits(key);
    fetchMock.mockClear();
    const limits = await getLimits(key);
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
