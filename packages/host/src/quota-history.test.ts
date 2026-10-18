import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionLimits } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { setToken } from './oauth.js';
import { initLimits, poll } from './limits.js';
import { recordQuotaHistory } from './quota-history.js';

let dir: string;
const key = 'chatgpt:private-account';
const now = 1_700_000_000_000;
const log = () => join(dir, 'quota-history.jsonl');
const rows = () => readFileSync(log(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-quota-history-'));
  setDataDir(dir);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  saveSettings({ providers: [{ id: 'configured-chatgpt', name: 'Private name', kind: 'chatgpt', enabled: true, auth: 'subscription', tokenKey: key, apiKey: 'secret-key' }] });
  initLimits(new EventEmitter());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

it('appends durable whitelist-only JSONL, not credentials, account IDs or content', () => {
  const snapshot = {
    updatedAt: now, staleAfterMs: 1000, planType: 'private-plan', creditsBalance: 10,
    accountId: 'private-account', content: 'private-content', accessToken: 'secret-token',
    windows: [{ id: '5h', label: 'private-label', scope: 'session', usedPercent: 25, resetAt: now + 1000, status: 'allowed', content: 'private-window' }],
  } as SubscriptionLimits;
  recordQuotaHistory(key, 'poll', snapshot);
  recordQuotaHistory(key, 'headers', snapshot);
  expect(rows()).toEqual(['poll', 'headers'].map((source) => ({
    timestamp: now, providerId: 'configured-chatgpt', source,
    windows: [{ id: '5h', scope: 'session', usedPercent: 25, resetsAt: now + 1000, status: 'allowed' }],
  })));
});

it('skips unknown providers without exposing the token key', () => {
  recordQuotaHistory('chatgpt:unknown-account', 'poll', { updatedAt: now, staleAfterMs: 1000, windows: [{ id: '5h', label: '5-hour', scope: 'session', usedPercent: 10, resetAt: 0, status: 'allowed' }] });
  expect(existsSync(log())).toBe(false);
});

it('logs successful polls once, not cached, throttled or failed reads; adds no polls', async () => {
  setToken(key, { provider: 'chatgpt', accessToken: 'secret-token', accountId: 'acct', expiresAt: now + 3600_000, obtainedAt: now });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 30, limit_window_seconds: 18000 } } })));
  await poll(key);
  await poll(key);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ source: 'poll', windows: [{ id: '5h', usedPercent: 30 }] });
  vi.setSystemTime(now + 31_000);
  fetchMock.mockResolvedValue(new Response('', { status: 500 }));
  await poll(key);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(rows()).toHaveLength(1);
});

it('keeps filesystem failures nonfatal for successful polls', async () => {
  mkdirSync(log());
  setToken(key, { provider: 'chatgpt', accessToken: 'secret-token', accountId: 'acct', expiresAt: now + 3600_000, obtainedAt: now });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 30, limit_window_seconds: 18000 } } })));
  expect(await poll(key)).toMatchObject({ windows: [{ usedPercent: 30 }] });
});
