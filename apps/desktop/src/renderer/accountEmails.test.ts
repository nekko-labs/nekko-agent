import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import { accountEmailOf, providerDisplayName } from './accountEmails.js';

const claude = (tokenKey?: string): ProviderConfig => ({ id: tokenKey ?? 'k', kind: 'anthropic', label: 'Anthropic (Claude)', baseUrl: '', enabled: true, auth: tokenKey ? 'subscription' : 'apikey', tokenKey });

describe('account emails', () => {
  const emails = { 'claude:a': 'davide@example.com', 'claude:b': 'davide@work.example' };
  it('names each signed-in plan by its own email', () => {
    expect(providerDisplayName(claude('claude:a'), emails)).toBe('Anthropic (Claude) · davide@example.com');
    expect(providerDisplayName(claude('claude:b'), emails)).toBe('Anthropic (Claude) · davide@work.example');
  });
  it('keeps the bare label without a known email or a sign-in', () => {
    expect(providerDisplayName(claude('claude:old'), emails)).toBe('Anthropic (Claude)');
    expect(providerDisplayName(claude(), emails)).toBe('Anthropic (Claude)');
    expect(accountEmailOf(claude(), emails)).toBeUndefined();
  });
});
