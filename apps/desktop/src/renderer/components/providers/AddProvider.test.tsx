import { describe, expect, it, vi } from 'vitest';
import type { OAuthStatus, ProviderConfig } from '@nekko-agent/shared';

// AddProvider imports the store, which reads browser globals at import time;
// node has none, so provide the minimum first (hoisted above module imports).
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1280,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
});

const { reconnectProviderConfig } = await import('./AddProvider.js');

const apiKeyCard: ProviderConfig = {
  id: 'anthropic-k1',
  kind: 'anthropic',
  label: 'Claude API',
  baseUrl: 'https://api.anthropic.com',
  auth: 'apikey',
  enabled: true,
};

const status: OAuthStatus = {
  tokenKey: 'claude',
  provider: 'claude',
  connected: true,
  state: 'success',
  accountId: 'acct-123',
};

describe('reconnectProviderConfig', () => {
  it('flips an api-key Anthropic card to subscription auth and drops the key', () => {
    const next = reconnectProviderConfig({ ...apiKeyCard, apiKey: 'sk-ant-dead' }, status);
    expect(next.auth).toBe('subscription');
    expect(next.apiKey).toBeUndefined();
    expect(next.tokenKey).toBe('claude');
    expect(next.accountId).toBe('acct-123');
  });

  it('keeps the card identity: id, label, baseUrl, custom model', () => {
    const next = reconnectProviderConfig({ ...apiKeyCard, customModelId: 'claude-opus-5' }, status);
    expect(next.id).toBe('anthropic-k1');
    expect(next.label).toBe('Claude API');
    expect(next.baseUrl).toBe('https://api.anthropic.com');
    expect(next.customModelId).toBe('claude-opus-5');
    expect(next.enabled).toBe(true);
  });

  it('keeps OpenRouter on metered api-key auth with the fresh key in the store', () => {
    const openrouter: ProviderConfig = { ...apiKeyCard, id: 'or-1', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
    const next = reconnectProviderConfig(openrouter, { ...status, provider: 'openrouter', tokenKey: 'openrouter' });
    expect(next.auth).toBe('apikey');
    expect(next.apiKey).toBeUndefined();
    expect(next.tokenKey).toBe('openrouter');
  });

  it('falls back to the existing token key and account when the status omits them', () => {
    const next = reconnectProviderConfig(
      { ...apiKeyCard, tokenKey: 'claude', accountId: 'acct-old' },
      { tokenKey: '', provider: 'claude', connected: true, state: 'success' },
    );
    expect(next.tokenKey).toBe('claude');
    expect(next.accountId).toBe('acct-old');
  });
});
