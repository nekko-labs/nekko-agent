import { describe, expect, it } from 'vitest';
import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { accountFamilies, accountIdentity, accountScopeLine, disambiguate, familyOf, identityLine, loginEntries, sharedEmail } from './providerAccounts.js';

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

describe('one login, one connection', () => {
  const personal = p('personal', 'claude-code', 'Claude subscription', { account: { signedIn: true, email: 'philip@example.test', scope: 'personal', name: 'Personal', plan: 'max', orgId: 'o1' } });
  const org = p('org', 'claude-code', 'Claude subscription · account-2', { claudeCode: { account: 'account-2' }, account: { signedIn: true, email: 'Philip@Example.test', scope: 'organization', name: 'Nekko Labs', plan: 'team', orgId: 'o2' } });
  const key = p('key', 'anthropic', 'Production', { apiKey: 'sk-x' });
  const out = p('out', 'claude-code', 'Claude subscription · old', { claudeCode: { account: 'old' }, account: { signedIn: false } });

  it('names an account from the identity providers:list carries, before any status read', () => {
    expect(accountIdentity(personal)).toMatchObject({ name: 'Personal', hint: 'Max', email: 'philip@example.test', organization: false });
    expect(accountIdentity(org)).toMatchObject({ name: 'Nekko Labs', hint: 'Team', organization: true });
    expect(accountIdentity(out)).toMatchObject({ signedOut: true });
  });

  it('says which account on the login it is', () => {
    expect(accountScopeLine(accountIdentity(personal))).toBe('Personal plan · Max');
    expect(accountScopeLine(accountIdentity(org))).toBe('Organization · Team');
    expect(accountScopeLine(accountIdentity(key))).toBe('');
  });

  it('groups the accounts of one email under that login, case-insensitively; keys and signed-out logins stand alone', () => {
    const providers = [personal, key, org, out];
    const ids = Object.fromEntries(providers.map((x) => [x.id, accountIdentity(x)]));
    expect(loginEntries(providers, ids).map((e) => (e.kind === 'login' ? ['login', e.email, e.providers.map((x) => x.id)] : ['account', e.provider.id]))).toEqual([
      ['login', 'philip@example.test', ['personal', 'org']],
      ['account', 'key'],
      ['account', 'out'],
    ]);
  });
});

describe('an organization seat whose plan Claude Code did not print', () => {
  it('still reads as the organization, without inventing a plan', () => {
    const seat = p('s', 'claude-code', 'Claude subscription', { account: { signedIn: true, email: 'a@b.test', scope: 'organization', name: 'Nekko Labs' } });
    expect(accountIdentity(seat)).toMatchObject({ name: 'Nekko Labs', organization: true, hint: undefined });
    expect(accountScopeLine(accountIdentity(seat))).toBe('Organization');
  });
});
