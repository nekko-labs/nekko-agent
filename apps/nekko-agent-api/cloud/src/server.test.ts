import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createCloudServer } from './server.js';
import { createBilling } from './billing.js';

/** Drives the real cloud server over Fastify `inject`, no network, no model. */
describe('cloud server (HTTP)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = createCloudServer({ dataRoot: mkdtempSync(join(tmpdir(), 'op-cloudsrv-')) }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const signup = async (email: string, password = 'longenough') => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password } });
    return res.json() as { token: string; account: { id: string }; entitlements: { maxWorkspaces: number } };
  };
  const call = (token: string, channel: string, args: unknown[] = []) =>
    app.inject({ method: 'POST', url: `/api/${channel}`, headers: { authorization: `Bearer ${token}` }, payload: { args } });

  it('advertises cloud mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json()).toEqual({ cloud: true, billing: false }); // no Stripe keys in this suite
  });

  it('rejects unauthenticated NekkoApi calls', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings:get', payload: { args: [] } });
    expect(res.statusCode).toBe(401);
  });

  it('authorizes relay enrollment for authenticated accounts only', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/relay/authorize' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().ok).toBe(false);

    const { token } = await signup('relay@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/relay/authorize',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, plan: 'free', maxDevices: 1 });
  });

  it('signup → authed dispatch reaches the per-account host', async () => {
    const { token, account } = await signup('alice@example.com');
    expect(account.id).toBeTruthy();
    const res = await call(token, 'settings:get');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('providers'); // real settings from the account's host
  });

  it('isolates data between accounts', async () => {
    const a = await signup('a@example.com');
    const b = await signup('b@example.com');
    const dir = mkdtempSync(join(tmpdir(), 'op-ws-'));
    await call(a.token, 'workspace:addByPath', [dir]);
    expect((await call(a.token, 'workspace:list')).json()).toHaveLength(1);
    expect((await call(b.token, 'workspace:list')).json()).toHaveLength(0); // B can't see A's workspace
  });

  it('enforces the free-plan workspace limit (server-side)', async () => {
    const { token } = await signup('c@example.com');
    await call(token, 'workspace:addByPath', [mkdtempSync(join(tmpdir(), 'op-ws-'))]);
    await call(token, 'workspace:addByPath', [mkdtempSync(join(tmpdir(), 'op-ws-'))]);
    const third = await call(token, 'workspace:addByPath', [mkdtempSync(join(tmpdir(), 'op-ws-'))]);
    expect(third.statusCode).toBe(400);
    expect(third.json().error).toMatch(/upgrade/i);
    expect((await call(token, 'workspace:list')).json()).toHaveLength(2);
  });
});

/** Billing endpoints with a Stripe integration injected (no network). */
describe('cloud billing (HTTP)', () => {
  const WHSEC = 'whsec_test';
  let app: FastifyInstance;

  beforeEach(async () => {
    const billing = createBilling({
      secretKey: 'sk_test',
      webhookSecret: WHSEC,
      prices: { pro: 'price_pro', team: 'price_team' },
      publicUrl: 'https://cloud.nekkoagent.com',
    });
    ({ app } = createCloudServer({ dataRoot: mkdtempSync(join(tmpdir(), 'op-billing-')), billing }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const signup = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'longenough' } });
    return res.json() as { token: string; account: { id: string } };
  };

  it('advertises billing in the auth config', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/config' })).json()).toEqual({ cloud: true, billing: true });
  });

  it('rejects unauthenticated checkout and an unknown plan', async () => {
    const noauth = await app.inject({ method: 'POST', url: '/api/billing/checkout', payload: { plan: 'pro' } });
    expect(noauth.statusCode).toBe(401);
    const { token } = await signup('plan@example.com');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { authorization: `Bearer ${token}` },
      payload: { plan: 'enterprise' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a webhook with a bad signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': 'bogus', 'content-type': 'application/json' },
      payload: { id: 'evt', type: 'checkout.session.completed', data: { object: {} } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('upgrades an account from a signed checkout.session.completed webhook', async () => {
    const { token, account } = await signup('upgrade@example.com');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).json().account.plan).toBe('free');

    const raw = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: account.id, customer: 'cus_abc', metadata: { plan: 'pro' } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', WHSEC).update(`${ts}.${raw}`).digest('hex');

    const hook = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(hook.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json().account.plan).toBe('pro');
    // pro entitlements now apply (maxWorkspaces is Infinity, which JSON serializes to null).
    expect(me.json().entitlements.plan).toBe('pro');
    expect(me.json().entitlements.cloudSync).toBe(true);
  });
});
