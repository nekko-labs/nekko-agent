import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRelay, MAX_SIGNAL_BYTES } from './server.js';
import { checkTicket, parseTicketKey, type Ticket } from './ticket.js';

/** Nekko Cloud Relay tickets and the account channel (decision 0116), over real sockets. */

const vector = JSON.parse(readFileSync(new URL('./relay-ticket-vector.json', import.meta.url), 'utf8'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const ROOM = 'a1b2c3d4e5f60718';

function ticket(p: Partial<Ticket>, key: KeyObject = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, scope: 'agent', acct: 'acct-1', dev: 'computer-1', room: ROOM, plan: 'pro', iat: now, exp: now + 3600, ...p };
  const body = `nkr1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`;
}

const apps: { close(): Promise<void> }[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) try { ws.close(); } catch { /* closed */ }
  for (const a of apps.splice(0)) await a.close();
});

async function start() {
  const built = buildRelay({ ticketKey: publicKey });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(built.app as any);
  return { url: `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`, ...built };
}

interface Sock { next(): Promise<any>; send(o: unknown): void; closed: Promise<{ code: number; reason: string }>; quiet(ms?: number): Promise<boolean> }

function open(url: string): Promise<Sock> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener('message', (ev: any) => {
    const v = JSON.parse(String(ev.data));
    const w = waiters.shift();
    w ? w(v) : queue.push(v);
  });
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.addEventListener('close', (ev: any) => res({ code: ev.code, reason: String(ev.reason) })));
  const sock: Sock = {
    closed,
    send: (o) => ws.send(JSON.stringify(o)),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((res, rej) => {
      waiters.push(res);
      setTimeout(() => rej(new Error('timed out waiting for frame')), 3000);
    }),
    // True when nothing arrives for `ms`.
    quiet: (ms = 150) => new Promise((res) => setTimeout(() => res(queue.length === 0), ms)),
  };
  return new Promise((res) => {
    ws.addEventListener('open', () => res(sock));
    ws.addEventListener('close', () => res(sock));
  });
}
const agent = (url: string, access?: string, room = ROOM) =>
  open(`${url}/relay?${new URLSearchParams({ room, role: 'agent', key: 'k', ...(access ? { access } : {}) })}`);

describe('ticket format', () => {
  it("checks the API's vector", () => {
    const key = parseTicketKey(vector.publicKey);
    expect(checkTicket(key, vector.ticket, vector.payload.iat)).toEqual(vector.payload);
    expect(checkTicket(key, vector.ticket, vector.payload.exp)).toBeNull();
    expect(checkTicket(parseTicketKey(Buffer.alloc(32, 1).toString('base64url')), vector.ticket)).toBeNull();
    expect(() => parseTicketKey('abc')).toThrow();
  });

  it('refuses a ticket signed by anyone else, altered, or with junk ids', () => {
    expect(checkTicket(publicKey, ticket({}))).not.toBeNull();
    expect(checkTicket(publicKey, ticket({}, generateKeyPairSync('ed25519').privateKey))).toBeNull();
    const [p, , s] = ticket({}).split('.');
    expect(checkTicket(publicKey, `${p}.${Buffer.from('{"v":1}').toString('base64url')}.${s}`)).toBeNull();
    expect(checkTicket(publicKey, ticket({ dev: 'has spaces' }))).toBeNull();
    expect(checkTicket(publicKey, ticket({ scope: 'agent', room: undefined }))).toBeNull();
    // A signed ticket still may not claim to run for days: it would hold a timer that long.
    expect(checkTicket(publicKey, ticket({ exp: Math.floor(Date.now() / 1000) + 2 * 24 * 3600 }))).toBeNull();
  });
});

describe('agents on Nekko Cloud Relay', () => {
  it('lets an agent in with a ticket for its room, and no other way', async () => {
    const { url } = await start();
    expect((await (await agent(url)).closed).code).toBe(4003);
    expect((await (await agent(url, ticket({}, generateKeyPairSync('ed25519').privateKey))).closed).code).toBe(4003);
    expect((await (await agent(url, ticket({ room: 'ffffffffffffffff' }))).closed).code).toBe(4003);
    expect((await (await agent(url, ticket({ scope: 'account' }))).closed).code).toBe(4003);

    // A repeated access parameter is not a ticket.
    const twice = await open(`${url}/relay?room=${ROOM}&role=agent&key=k&access=${ticket({})}&access=${ticket({})}`);
    expect((await twice.closed).code).toBe(4003);

    const ok = await agent(url, ticket({}));
    const phone = await open(`${url}/relay?${new URLSearchParams({ room: ROOM, role: 'client', key: 'k' })}`);
    expect(await phone.next()).toEqual({ type: 'agent-online' });
    expect((await ok.next()).type).toBe('client-open');
  });

  it("keeps another account's agent out of a room in use", async () => {
    const { url } = await start();
    await agent(url, ticket({}));
    const other = await agent(url, ticket({ acct: 'acct-2' }));
    expect(await other.closed).toEqual({ code: 4003, reason: 'room in use' });
  });

  it('renews a ticket in place, and closes an agent whose ticket runs out', async () => {
    const { url } = await start();
    const now = Math.floor(Date.now() / 1000);
    const a = await agent(url, ticket({ exp: now + 2 }));
    a.send({ type: 'access', access: ticket({ acct: 'acct-2' }) });
    expect(await a.next()).toEqual({ type: 'access-denied' });
    a.send({ type: 'access', access: ticket({ room: 'ffffffffffffffff' }) });
    expect(await a.next()).toEqual({ type: 'access-denied' });
    a.send({ type: 'access', access: ticket({ exp: now + 3600 }) });
    expect(await a.next()).toEqual({ type: 'access-ok', expiresAt: new Date((now + 3600) * 1000).toISOString() });
    // Past the first ticket's expiry, still on.
    await new Promise((r) => setTimeout(r, 2200));
    expect(await a.quiet(10)).toBe(true);
  }, 10_000);

  it('closes at expiry without a renewal', async () => {
    const { url } = await start();
    const now = Math.floor(Date.now() / 1000);
    const a = await agent(url, ticket({ exp: now + 1 }));
    expect(await a.closed).toEqual({ code: 4003, reason: 'Nekko Cloud Relay ticket expired' });
  }, 5_000);
});

describe('the account channel', () => {
  const join = async (url: string, p: Partial<Ticket>, kind: 'computer' | 'phone') => {
    const s = await open(`${url}/account`);
    s.send({ type: 'auth', access: ticket({ scope: 'account', room: undefined, ...p }), kind });
    return s;
  };

  it('refuses anything but an account ticket', async () => {
    const { url } = await start();
    const s = await open(`${url}/account`);
    s.send({ type: 'auth', access: ticket({}) });
    expect((await s.closed).code).toBe(4003);
    const t = await open(`${url}/account`);
    t.send({ type: 'nudge', topic: 'sync' });
    expect((await t.closed).code).toBe(4003);
  });

  it("tells an account's devices who is online, as they come and go", async () => {
    const { url, accounts } = await start();
    const mac = await join(url, { dev: 'mac' }, 'computer');
    expect(await mac.next()).toMatchObject({ type: 'ready', dev: 'mac', devices: [{ dev: 'mac', kind: 'computer' }] });
    const phone = await join(url, { dev: 'phone' }, 'phone');
    expect((await phone.next()).devices).toEqual([{ dev: 'mac', kind: 'computer' }, { dev: 'phone', kind: 'phone' }]);
    expect(await mac.next()).toEqual({ type: 'presence', dev: 'phone', kind: 'phone', online: true });

    // Another account sees none of it.
    const stranger = await join(url, { acct: 'acct-2', dev: 'x' }, 'computer');
    expect((await stranger.next()).devices).toEqual([{ dev: 'x', kind: 'computer' }]);
    expect(await mac.quiet()).toBe(true);

    // A second socket of the same device is not news; its last one closing is.
    const mac2 = await join(url, { dev: 'mac' }, 'computer');
    await mac2.next();
    expect(await phone.quiet()).toBe(true);
    sockets[sockets.length - 1].close();
    expect(await phone.quiet()).toBe(true);
    sockets[0].close();
    expect(await phone.next()).toEqual({ type: 'presence', dev: 'mac', kind: 'computer', online: false });
    expect(accounts.get('acct-1')!.size).toBe(1);
  });

  it('passes content-free nudges and sealed signals between the same account only', async () => {
    const { url } = await start();
    const mac = await join(url, { dev: 'mac' }, 'computer');
    await mac.next();
    const phone = await join(url, { dev: 'phone' }, 'phone');
    await phone.next();
    await mac.next(); // presence
    const stranger = await join(url, { acct: 'acct-2', dev: 'phone' }, 'phone');
    await stranger.next();

    mac.send({ type: 'nudge', topic: 'sync', rev: 41 });
    expect(await phone.next()).toEqual({ type: 'nudge', topic: 'sync', rev: 41, from: 'mac' });
    mac.send({ type: 'nudge', topic: 'chat text?' });
    mac.send({ type: 'nudge', topic: 'routes', rev: -1 });
    expect(await phone.next()).toEqual({ type: 'nudge', topic: 'routes', from: 'mac' });

    mac.send({ type: 'signal', to: 'phone', data: 'sealed-bytes' });
    expect(await phone.next()).toEqual({ type: 'signal', from: 'mac', data: 'sealed-bytes' });
    mac.send({ type: 'signal', to: 'phone', data: 'x'.repeat(MAX_SIGNAL_BYTES + 1) });
    expect(await phone.quiet()).toBe(true);
    expect(await stranger.quiet(10)).toBe(true);
    expect(await mac.quiet(10)).toBe(true);
  });

  it('renews only with a ticket for the same account and device', async () => {
    const { url } = await start();
    const mac = await join(url, { dev: 'mac' }, 'computer');
    await mac.next();
    mac.send({ type: 'access', access: ticket({ scope: 'account', room: undefined, dev: 'other' }) });
    expect(await mac.next()).toEqual({ type: 'access-denied' });
    mac.send({ type: 'access', access: ticket({ scope: 'account', room: undefined, dev: 'mac' }) });
    expect((await mac.next()).type).toBe('access-ok');
  });

  it('is absent on a relay without a ticket key', async () => {
    const { app } = buildRelay({ allowUnauthenticated: true });
    apps.push(app as any);
    expect((await app.inject({ method: 'GET', url: '/account' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true, rooms: 0 });
  });
});
