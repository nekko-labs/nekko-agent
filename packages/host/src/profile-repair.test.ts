import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToDataRoot, applyToSettings, planDedupe, remapIds } from './profile-repair.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const claude = (id: string, tokenKey: string) => ({ id, kind: 'anthropic', auth: 'subscription', tokenKey, baseUrl: 'https://api.anthropic.com' });
const accounts: Record<string, string> = { 'claude:a': 'acct1', 'claude:b': 'acct1', 'claude:c': 'acct1', 'claude:d': 'acct2' };

describe('planDedupe', () => {
  it('folds subscriptions on the same account into the one with most history', () => {
    const history: Record<string, number> = { 'anthropic-x': 2291, 'anthropic-y': 526 };
    const plan = planDedupe({ providers: [claude('anthropic-new', 'claude:a'), claude('anthropic-x', 'claude:b'), claude('anthropic-y', 'claude:c'), claude('other', 'claude:d')] },
      { accountOf: (k) => accounts[k], prefer: (id) => history[id] ?? 0 });
    expect(plan.providers).toEqual({ 'anthropic-new': 'anthropic-x', 'anthropic-y': 'anthropic-x' });
  });

  it('never folds two subscriptions whose account is unknown', () => {
    const plan = planDedupe({ providers: [claude('a', 'claude:zz'), claude('b', 'claude:yy')] }, { accountOf: () => undefined });
    expect(plan.providers).toEqual({});
  });

  it('folds local servers by address, treating localhost and 127.0.0.1 and /v1 alike', () => {
    const plan = planDedupe({ providers: [
      { id: 'lm1', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1338/v1' },
      { id: 'lm2', kind: 'lmstudio', baseUrl: 'http://localhost:1338/v1/' },
      { id: 'lm3', kind: 'lmstudio', baseUrl: 'http://10.5.0.2:1338' },
    ] });
    expect(plan.providers).toEqual({ lm2: 'lm1' });
  });

  it('folds folders by resolved path, case-insensitively on Windows', () => {
    const plan = planDedupe({ workspaces: [
      { id: 'w1', path: 'C:\\Users\\p\\code' }, { id: 'w2', path: 'c:\\users\\p\\code\\' }, { id: 'w3', path: 'C:\\Users\\p\\code\\app' },
    ] }, { platform: 'win32', prefer: (id) => (id === 'w2' ? 10 : 0) });
    expect(plan.folders).toEqual({ w1: 'w2' });
  });

  it('honours an explicit survivor', () => {
    const plan = planDedupe({ providers: [claude('a', 'claude:a'), claude('b', 'claude:b')] }, { accountOf: (k) => accounts[k], prefer: (id) => (id === 'a' ? 9 : 0), keepProvider: { anthropic: 'b' } });
    expect(plan.providers).toEqual({ a: 'b' });
  });
});

describe('remapIds', () => {
  const plan = { providers: { old: 'new' }, folders: { w2: 'w1' }, removeProviders: [] };
  it('rewrites exact ids, provider::model keys, and dedupes id lists', () => {
    expect(remapIds({ providerId: 'old', fav: ['old::m', 'new::m', 'x::m'], supportingWorkspaceIds: ['w1', 'w2'], workspaceId: 'w2' }, plan))
      .toEqual({ providerId: 'new', fav: ['new::m', 'x::m'], supportingWorkspaceIds: ['w1'], workspaceId: 'w1' });
  });
  it('leaves prose that merely contains an id alone', () => {
    expect(remapIds({ text: 'the old provider and w2 folder' }, plan)).toEqual({ text: 'the old provider and w2 folder' });
  });
});

describe('applyToSettings', () => {
  it('drops folded and removed providers and clears a default that pointed at a removed one', () => {
    const next = applyToSettings({
      providers: [{ id: 'keep' }, { id: 'dup' }, { id: 'dead' }], workspaces: [{ id: 'w1', path: '/a' }, { id: 'w2', path: '/a' }],
      defaultProviderId: 'dead', defaultModelId: 'm', favoriteModels: ['dup::m', 'dead::m', 'keep::n'],
    }, { providers: { dup: 'keep' }, folders: { w2: 'w1' }, removeProviders: ['dead'] });
    expect((next.providers as Array<{ id: string }>).map((p) => p.id)).toEqual(['keep']);
    expect((next.workspaces as Array<{ id: string }>).map((p) => p.id)).toEqual(['w1']);
    expect(next.defaultProviderId).toBeUndefined();
    expect(next.favoriteModels).toEqual(['keep::m', 'keep::n']);
  });
});

describe('dedupeProfile removal rules', () => {
  it('turns removing a duplicate of a kept provider into a fold, and removing a survivor drops its group', async () => {
    const { dedupeProfile } = await import('./legacy-profiles.js');
    const root = mkdtempSync(join(tmpdir(), 'nekko-repair-')); dirs.push(root);
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ workspaces: [], providers: [
      { id: 'local', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1338/v1' }, { id: 'local-dup', kind: 'lmstudio', baseUrl: 'http://localhost:1338/v1' },
      { id: 'lan', kind: 'lmstudio', baseUrl: 'http://10.0.0.2:1338' }, { id: 'lan-dup', kind: 'lmstudio', baseUrl: 'http://10.0.0.2:1338/v1' },
    ] }));
    const plan = dedupeProfile(root, 'win32', { removeProviders: ['local-dup', 'lan'] })!;
    expect(plan.providers).toEqual({ 'local-dup': 'local' });
    expect(plan.removeProviders.sort()).toEqual(['lan', 'lan-dup']);
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).providers.map((p: { id: string }) => p.id)).toEqual(['local']);
  });
});

describe('applyToDataRoot', () => {
  it('rewrites sessions, usage and quota history so totals are unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'nekko-repair-')); dirs.push(root);
    mkdirSync(join(root, 'sessions'));
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ providers: [{ id: 'keep' }, { id: 'dup' }], workspaces: [] }));
    writeFileSync(join(root, 'sessions', 's1.json'), JSON.stringify({ id: 's1', providerId: 'dup', messages: [{ text: 'dup' }] }));
    writeFileSync(join(root, 'sessions', 's2.json'), JSON.stringify({ id: 's2', providerId: 'keep' }));
    writeFileSync(join(root, 'usage.jsonl'), [{ providerId: 'dup', inputTokens: 5 }, { providerId: 'keep', inputTokens: 7 }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(root, 'quota-history.jsonl'), JSON.stringify({ providerId: 'dup' }) + '\n');
    const r = applyToDataRoot(root, { providers: { dup: 'keep' }, folders: {}, removeProviders: [] });
    expect(r.sessions).toBe(1);
    expect(r.usage).toBe(1);
    const s1 = JSON.parse(readFileSync(join(root, 'sessions', 's1.json'), 'utf8'));
    expect(s1.providerId).toBe('keep');
    expect(s1.messages[0].text).toBe('keep');
    const usage = readFileSync(join(root, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(usage.map((u) => u.providerId)).toEqual(['keep', 'keep']);
    expect(usage.reduce((n, u) => n + u.inputTokens, 0)).toBe(12);
    expect(readFileSync(join(root, 'quota-history.jsonl'), 'utf8')).toContain('"keep"');
  });
});
