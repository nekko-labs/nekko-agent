import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../store.js', async (original) => {
  const actual = await original<typeof import('../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => ({ byToken: {}, answered: new Set() }) }));
import type { ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { ProviderFamilies, addKindFor, busiestWindow } from './ProviderFamilies.js';
import { nextAccountFolder } from '../components/claude/AddLoginAccount.js';

const p = (id: string, kind: ProviderConfig['kind'], label: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, kind, label, baseUrl: '', enabled: true, ...extra });
const providers = [
  p('personal', 'claude-code', 'Claude subscription'),
  p('work', 'claude-code', 'Claude subscription · Work', { claudeCode: { account: 'work' } }),
  p('production', 'anthropic', 'Production', { apiKey: 'sk-never-render' }),
  p('gpt', 'chatgpt', 'ChatGPT (subscription)'),
  p('lm', 'lmstudio', 'LM Studio'),
];

describe('provider families on the Models page', () => {
  const html = renderToStaticMarkup(<ProviderFamilies providers={providers} onAdd={() => {}} renderDetails={() => null} />);
  it('lists each family with the accounts that come with it, and no local servers', () => {
    expect(html).toContain('data-provider-family="claude"');
    expect(html).toContain('data-provider-family="openai"');
    expect(html).not.toContain('LM Studio');
    const claude = html.slice(html.indexOf('data-provider-family="claude"'), html.indexOf('data-provider-family="openai"'));
    expect(claude.match(/data-account-row=/g)).toHaveLength(3);
    expect(claude).toContain('3 accounts');
    expect(claude).toContain('>Work<');
    expect(claude).toContain('>Production<');
  });
  it('uses no card or bordered tile, one hairline between families, and never renders a key', () => {
    expect(html).not.toMatch(/class="[^"]*\bcard\b/);
    expect(html.match(/quiet-rule/g)).toHaveLength(1);
    expect(html).not.toContain('sk-never-render');
  });
  it('offers Add account per family, opening the setup that adds one there', () => {
    expect(html.match(/\+ Add account/g)).toHaveLength(2);
    expect(addKindFor({ id: 'claude', name: 'Claude', providers: [] })).toBe('anthropic');
    expect(addKindFor({ id: 'openai', name: 'OpenAI', providers: [providers[3]] })).toBe('chatgpt');
    expect(addKindFor({ id: 'openai', name: 'OpenAI', providers: [p('o', 'openai', 'OpenAI API')] })).toBe('openai');
  });
});

describe('account usage on the row', () => {
  const at = Date.now();
  const limits = (windows: Partial<SubscriptionLimits['windows'][number]>[]): SubscriptionLimits => ({ updatedAt: at, staleAfterMs: 1, windows: windows.map((w, i) => ({ id: `w${i}`, label: 'w', scope: 'session', usedPercent: 0, status: 'allowed', resetAt: at, ...w })) as SubscriptionLimits['windows'] });
  it('names the window closest to its limit', () => {
    expect(busiestWindow(limits([{ label: 'Week', usedPercent: 21 }, { label: '5 hours', usedPercent: 62 }]))).toEqual({ text: '5 hours 62%', tone: null });
    expect(busiestWindow(limits([{ label: '5 hours', usedPercent: 100, status: 'rate_limited' }]))?.tone).toBe('danger');
  });
  it('says nothing when no usage is reported', () => {
    expect(busiestWindow(undefined)).toBeNull();
    expect(busiestWindow(limits([]))).toBeNull();
  });
});

describe('one Claude login with a personal plan and an organization seat', () => {
  const login = [
    p('personal', 'claude-code', 'Claude subscription', { account: { signedIn: true, email: 'philip@example.test', scope: 'personal', name: 'Personal', plan: 'max' } }),
    p('org', 'claude-code', 'Claude subscription · account-2', { claudeCode: { account: 'account-2' }, account: { signedIn: true, email: 'philip@example.test', scope: 'organization', name: 'Nekko Labs', plan: 'team' } }),
    p('production', 'anthropic', 'Production', { apiKey: 'sk-never-render' }),
  ];
  const html = renderToStaticMarkup(<ProviderFamilies providers={login} onAdd={() => {}} renderDetails={() => null} />);
  it('shows the login once, as one connection, with both accounts under it', () => {
    expect(html.match(/data-login="philip@example.test"/g)).toHaveLength(1);
    const group = html.slice(html.indexOf('data-login='), html.indexOf('data-account-row="production"'));
    expect(group.match(/data-account-row=/g)).toHaveLength(2);
    expect(group).toContain('Claude subscription · Personal and Nekko Labs');
    expect(group).toContain('Personal plan · Max');
    expect(group).toContain('Organization · Team');
    expect(group).toContain('+ Add another account on this login');
    // The heading's summary does not repeat the email the login row says.
    expect(html.slice(html.indexOf('data-family-summary'), html.indexOf('data-family-summary') + 80)).not.toContain('philip@');
  });
  it('picks a folder name nobody uses for the other account', () => {
    expect(nextAccountFolder(login)).toBe('account-3');
    expect(nextAccountFolder([])).toBe('account-2');
  });
});
