import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudStore } from './accounts.js';
import { entitlements, requireWithin, requireFeature } from './entitlements.js';

function freshStore(): CloudStore {
  return new CloudStore(mkdtempSync(join(tmpdir(), 'op-cloud-')));
}

describe('accounts + auth', () => {
  let store: CloudStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('signs up, logs in, and verifies the token', () => {
    const account = store.signup('Alice@Example.com', 'hunter2pass');
    expect(account.email).toBe('alice@example.com'); // normalized
    expect(account.plan).toBe('free');
    expect(account.passwordHash).not.toContain('hunter2pass'); // never plaintext

    const { token, account: logged } = store.login('alice@example.com', 'hunter2pass');
    expect(logged.id).toBe(account.id);
    expect(store.verifyToken(token)?.id).toBe(account.id);
  });

  it('rejects wrong password and unknown tokens', () => {
    store.signup('bob@example.com', 'correctpass');
    expect(() => store.login('bob@example.com', 'wrongpass')).toThrow(/incorrect/i);
    expect(store.verifyToken('nope')).toBeUndefined();
    expect(store.verifyToken(undefined)).toBeUndefined();
  });

  it('rejects bad email, short password, and duplicate signup', () => {
    expect(() => store.signup('notanemail', 'longenough')).toThrow(/valid email/i);
    expect(() => store.signup('c@example.com', 'short')).toThrow(/8 characters/i);
    store.signup('c@example.com', 'longenough');
    expect(() => store.signup('C@Example.com', 'longenough')).toThrow(/already exists/i);
  });

  it('logout invalidates the token', () => {
    store.signup('d@example.com', 'longenough');
    const { token } = store.login('d@example.com', 'longenough');
    expect(store.verifyToken(token)).toBeDefined();
    store.logout(token);
    expect(store.verifyToken(token)).toBeUndefined();
  });

  it('persists accounts across store instances (same root)', () => {
    const acct = store.signup('e@example.com', 'longenough');
    const reopened = new CloudStore((store as unknown as { root: string }).root);
    expect(reopened.findByEmail('e@example.com')?.id).toBe(acct.id);
  });
});

describe('entitlements', () => {
  it('free is limited, pro/team are not', () => {
    expect(entitlements('free').maxWorkspaces).toBe(2);
    expect(entitlements('free').zdr).toBe(false);
    expect(entitlements('pro').maxWorkspaces).toBe(Infinity);
    expect(entitlements('pro').zdr).toBe(true);
    expect(entitlements('team').maxDevices).toBe(25);
  });

  it('requireWithin throws at the limit, passes under it', () => {
    expect(() => requireWithin('free', 'maxWorkspaces', 2)).toThrow(/upgrade/i);
    expect(() => requireWithin('free', 'maxWorkspaces', 1)).not.toThrow();
    expect(() => requireWithin('pro', 'maxWorkspaces', 9999)).not.toThrow();
  });

  it('requireFeature gates boolean features by plan', () => {
    expect(() => requireFeature('free', 'cloudSync')).toThrow(/not available/i);
    expect(() => requireFeature('pro', 'cloudSync')).not.toThrow();
  });
});
