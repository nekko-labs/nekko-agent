import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import { accountEmailOf, accountShortName, accountSiblings, providerDisplayName } from './accountEmails.js';

const claude = (tokenKey?: string): ProviderConfig => ({ id: tokenKey ?? 'k', kind: 'anthropic', label: 'Claude API', baseUrl: '', enabled: true, auth: tokenKey ? 'subscription' : 'apikey', tokenKey });

describe('account emails', () => {
  const emails = { 'claude:a': 'davide@example.com', 'claude:b': 'davide@work.example' };
  it('names each signed-in plan by its own email', () => {
    expect(providerDisplayName(claude('claude:a'), emails)).toBe('Claude API · davide@example.com');
    expect(providerDisplayName(claude('claude:b'), emails)).toBe('Claude API · davide@work.example');
  });
  it('keeps the bare label without a known email or a sign-in', () => {
    expect(providerDisplayName(claude('claude:old'), emails)).toBe('Claude API');
    expect(providerDisplayName(claude(), emails)).toBe('Claude API');
    expect(accountEmailOf(claude(), emails)).toBeUndefined();
  });
});

describe('account switching', () => {
  const p = (id: string, kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, kind, label: id, baseUrl: '', enabled: true, ...extra });
  const providers = [
    p('gpt-personal', 'chatgpt', { tokenKey: 'chatgpt:a' }),
    p('cc', 'claude-code'),
    p('gpt-work', 'chatgpt', { tokenKey: 'chatgpt:b' }),
    p('cc-work', 'claude-code', { claudeCode: { account: 'work' } }),
    p('gpt-off', 'chatgpt', { enabled: false }),
    p('ollama-a', 'ollama'),
    p('ollama-b', 'ollama'),
    p('key', 'anthropic'),
  ];
  it('lists every enabled account of the same kind, the current one included', () => {
    expect(accountSiblings(providers, providers[0]).map((x) => x.id)).toEqual(['gpt-personal', 'gpt-work']);
    expect(accountSiblings(providers, providers[3]).map((x) => x.id)).toEqual(['cc', 'cc-work']);
  });
  it('offers no switcher for a single account or a local server', () => {
    expect(accountSiblings(providers, providers[7])).toEqual([]);
    expect(accountSiblings(providers, providers[5])).toEqual([]);
    expect(accountSiblings(providers, undefined)).toEqual([]);
  });
  it('names an account by its email when known', () => {
    expect(accountShortName(providers[0], { 'chatgpt:a': 'me@example.com' })).toBe('me@example.com');
    expect(accountShortName(providers[3], {})).toBe('cc-work');
  });
});
