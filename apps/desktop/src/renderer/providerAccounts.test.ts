import { describe, expect, it } from 'vitest';
import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { accountFamilies, accountIdentity, disambiguate, familyOf, identityLine, sharedEmail } from './providerAccounts.js';

const p = (id: string, kind: ProviderConfig['kind'], label: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, kind, label, baseUrl: '', enabled: true, ...extra });
const plan = (subscriptionType: string, orgName?: string): ClaudeCodeStatus => ({
  installed: true, version: '2', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription',
  email: 'alex@example.test', orgName: orgName ?? "alex@example.test's Organization", subscriptionType,
});

describe('account families', () => {
  it('groups every way of reaching Claude under one family, and ChatGPT with the OpenAI API', () => {
    const providers = [
      p('cc', 'claude-code', 'Claude subscription'),
      p('gpt', 'chatgpt', 'ChatGPT (subscription)'),
      p('api', 'anthropic', 'Production'),
      p('aws', 'bedrock', 'Client AWS'),
      p('oai', 'openai', 'OpenAI API'),
      p('lm', 'lmstudio', 'LM Studio'),
    ];
    const families = accountFamilies(providers);
    expect(families.map((f) => [f.name, f.providers.map((x) => x.id)])).toEqual([
      ['Claude', ['cc', 'api', 'aws']],
      ['OpenAI', ['gpt', 'oai']],
      ['LM Studio', ['lm']],
    ]);
  });
  it('keeps each local server and custom endpoint its own family', () => {
    expect(familyOf(p('a', 'ollama', 'Ollama')).id).not.toBe(familyOf(p('b', 'ollama', 'Ollama on desk')).id);
    expect(familyOf(p('c', 'openai-compat', 'My gateway', { baseUrl: 'https://gw.example/v1' })).name).toBe('My gateway');
    expect(familyOf(p('g', 'openai-compat', 'Google Gemini', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' })).name).toBe('Gemini');
  });
});

describe('account identity', () => {
  it('reads one email with a personal plan and an organization seat as two different accounts', () => {
    const personal = accountIdentity(p('cc', 'claude-code', 'Claude subscription'), { claude: plan('max') });
    const work = accountIdentity(p('ccw', 'claude-code', 'Claude subscription · Work', { claudeCode: { account: 'work' } }), { claude: plan('team', 'Acme Inc') });
    expect(identityLine(personal)).toBe('Personal · Max');
    expect(identityLine(work)).toBe('Acme Inc · Team');
    expect(work.organization).toBe(true);
    expect(sharedEmail([personal, work])).toBe('alex@example.test');
  });
  it('uses the typed name for a personal plan and while the status is unknown', () => {
    expect(accountIdentity(p('c', 'claude-code', 'Claude subscription · Side project', { claudeCode: { account: 'side' } }), { claude: plan('pro') }).name).toBe('Side project');
    expect(accountIdentity(p('c', 'claude-code', 'Claude subscription · Work')).name).toBe('Work');
    expect(accountIdentity(p('c', 'claude-code', 'Claude subscription')).name).toBe('Subscription');
  });
  it('says when a saved login is signed out instead of presenting it as usable', () => {
    const id = accountIdentity(p('c', 'claude-code', 'Claude subscription · Work'), { claude: { installed: true, version: '2', loggedIn: false } });
    expect(id).toMatchObject({ name: 'Work', hint: 'Signed out', signedOut: true });
  });
  it('names API accounts by their saved name with the billing route as the hint, never the key', () => {
    const prod = p('api', 'anthropic', 'Production', { apiKey: 'sk-never-render' });
    expect(identityLine(accountIdentity(prod))).toBe('Production · API');
    expect(JSON.stringify(accountIdentity(prod))).not.toContain('sk-never-render');
    expect(identityLine(accountIdentity(p('a', 'anthropic', 'Claude API')))).toBe('Anthropic · API');
    expect(identityLine(accountIdentity(p('b', 'bedrock', 'Client AWS')))).toBe('Client AWS · Bedrock');
    expect(identityLine(accountIdentity(p('g', 'chatgpt', 'ChatGPT (subscription)'), { email: 'me@home.example' }))).toBe('ChatGPT · Subscription');
  });
  it('tells two same-named accounts apart by email, both of them', () => {
    const out = disambiguate({
      a: { name: 'ChatGPT', hint: 'Subscription', email: 'me@home.example' },
      b: { name: 'ChatGPT', hint: 'Subscription', email: 'me@work.example' },
      c: { name: 'Production', hint: 'API' },
    }, ['a', 'b', 'c']);
    expect([out.a.name, out.b.name, out.c.name]).toEqual(['me@home.example', 'me@work.example', 'Production']);
  });
  it('shares an email when every account that reports one agrees; a keyed account does not disagree', () => {
    expect(sharedEmail([{ name: 'a', email: 'X@e.test' }, { name: 'b', email: 'x@e.test' }])).toBe('X@e.test');
    expect(sharedEmail([{ name: 'a', email: 'x@e.test' }, { name: 'Production', hint: 'API' }])).toBe('x@e.test');
    expect(sharedEmail([{ name: 'a', email: 'x@e.test' }, { name: 'b', email: 'y@e.test' }])).toBeUndefined();
    expect(sharedEmail([{ name: 'a' }, { name: 'b' }])).toBeUndefined();
  });
});
