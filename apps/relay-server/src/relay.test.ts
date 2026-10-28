import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRelay } from './server.js';
import type { ActivityPush, CardPush, PushSender } from './push.js';

/** Live-socket protocol tests: real Fastify WS server + Node's global WebSocket. */

const openSockets: WebSocket[] = [];
const apps: { close(): Promise<void> }[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  for (const app of apps.splice(0)) await app.close();
  for (const s of httpServers.splice(0)) await new Promise((r) => s.close(r));
});

async function startRelay(opts: Parameters<typeof buildRelay>[0] = {}) {
  const { app, rooms } = buildRelay({ allowUnauthenticated: true, ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app as any);
  const port = (app.server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}`, rooms };
}

interface Sock {
  ws: WebSocket;
  next(): Promise<any>;
  send(obj: unknown): void;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string, params: Record<string, string>): Promise<Sock> {
  const q = new URLSearchParams(params).toString();
  const ws = new WebSocket(`${url}/relay?${q}`);
  openSockets.push(ws);
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener('message', (ev: any) => {
    const v = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    const w = waiters.shift();
    w ? w(v) : queue.push(v);
  });
  const closed = new Promise<{ code: number; reason: string }>((res) => {
    ws.addEventListener('close', (ev: any) => res({ code: ev.code, reason: String(ev.reason || '') }));
  });
  const sock: Sock = {
    ws,
    closed,
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res, rej) => {
            waiters.push(res);
            setTimeout(() => rej(new Error('timed out waiting for frame')), 4000);
          }),
  };
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(sock));
    ws.addEventListener('close', () => res(sock)); // rejected connections resolve too; assert via `closed`
    ws.addEventListener('error', () => {
      /* close follows */
    });
    setTimeout(() => rej(new Error('connect timeout')), 4000);
  });
}

describe('relay v2 routing', () => {
  it('tags clients with cids, forwards to the agent, and unicasts back', async () => {
    const { url } = await startRelay();
    const agent = await connect(url, { room: 'r1', role: 'agent', key: 'k' });
    const a = await connect(url, { room: 'r1', role: 'client', key: 'k' });
    const b = await connect(url, { room: 'r1', role: 'client', key: 'k' });

    expect(await a.next()).toEqual({ type: 'agent-online' });
    expect(await b.next()).toEqual({ type: 'agent-online' });
    const openA = await agent.next();
    const openB = await agent.next();
    expect(openA.type).toBe('client-open');
    expect(openB.type).toBe('client-open');
    expect(openA.cid).not.toBe(openB.cid);

    a.send({ enc: 'ciphertext-from-a' });
    const fromA = await agent.next();
    expect(fromA).toEqual({ type: 'c', cid: openA.cid, data: JSON.stringify({ enc: 'ciphertext-from-a' }) });

    // Unicast to A only; B must not see it.
    agent.send({ type: 'd', cid: openA.cid, data: JSON.stringify({ enc: 'reply-for-a' }) });
    expect(await a.next()).toEqual({ enc: 'reply-for-a' });
    b.send({ enc: 'ping' }); // fence: b's next frame proves nothing arrived before it
    await agent.next();
    agent.send({ type: 'd', cid: openB.cid, data: JSON.stringify({ enc: 'reply-for-b' }) });
    expect(await b.next()).toEqual({ enc: 'reply-for-b' });
  });

  it('rejects clients with a wrong key and unpaired rooms', async () => {
    const { url } = await startRelay();
    const noAgent = await connect(url, { room: 'empty', role: 'client', key: 'k' });
    expect((await noAgent.closed).code).toBe(1008);

    await connect(url, { room: 'r2', role: 'agent', key: 'right' });
    const bad = await connect(url, { room: 'r2', role: 'client', key: 'wrong' });
    expect((await bad.closed).code).toBe(1008);
  });

  it('kicks a client on the agent’s request', async () => {
    const { url } = await startRelay();
    const agent = await connect(url, { room: 'r3', role: 'agent', key: 'k' });
    const c = await connect(url, { room: 'r3', role: 'client', key: 'k' });
    await c.next(); // agent-online
    const { cid } = await agent.next();
    agent.send({ type: 'kick', cid });
    const closed = await c.closed;
    expect(closed.code).toBe(4001);
    expect(await agent.next()).toEqual({ type: 'client-close', cid });
  });

  it('caps clients per room', async () => {
    const { url } = await startRelay({ limits: { maxClientsPerRoom: 1 } });
    await connect(url, { room: 'r4', role: 'agent', key: 'k' });
    await connect(url, { room: 'r4', role: 'client', key: 'k' });
    const second = await connect(url, { room: 'r4', role: 'client', key: 'k' });
    expect((await second.closed).code).toBe(1013);
  });

  it('updates and ends Live Activities by tag, even while the phone is connected', async () => {
    const pushes: { token: string; push: ActivityPush; app?: string }[] = [];
    const pushSender: PushSender = {
      enabled: true,
      send: async () => {},
      sendActivity: async (token, push, app) => void pushes.push({ token, push, app }),
    };
    const { url, rooms } = await startRelay({ pushSender });
    const agent = await connect(url, { room: 'r7', role: 'agent', key: 'k' });
    const c = await connect(url, { room: 'r7', role: 'client', key: 'k' });
    await c.next();
    await agent.next();
    const dev = '00000000-0000-4000-8000-000000000003';
    const tag = 'a'.repeat(32);
    c.send({ type: 'register-activity', deviceId: dev, tag, token: 'ab'.repeat(32), app: 'dev.nekkolabs.nekkoagent' });
    // Malformed registrations are ignored.
    c.send({ type: 'register-activity', deviceId: 'nope', tag, token: 'ab'.repeat(32) });
    c.send({ type: 'register-activity', deviceId: dev, tag: 'short', token: 'ab'.repeat(32) });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r7')!.activities.get(tag)!.size).toBe(1);

    agent.send({ type: 'activity', tag, phase: 'approval', callId: 'tc1', severity: 'high' });
    agent.send({ type: 'activity', tag: 'b'.repeat(32), phase: 'running' }); // nobody registered it
    agent.send({ type: 'activity', tag, phase: 'bogus' });
    agent.send({ type: 'activity', tag, phase: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes).toEqual([
      { token: 'ab'.repeat(32), push: { event: 'update', phase: 'approval', callId: 'tc1', severity: 'high' }, app: 'dev.nekkolabs.nekkoagent' },
      { token: 'ab'.repeat(32), push: { event: 'end', phase: 'done' }, app: 'dev.nekkolabs.nekkoagent' },
    ]);
    // Ended: the tag is forgotten and a late update pushes nothing.
    expect(rooms.get('r7')!.activities.has(tag)).toBe(false);
    agent.send({ type: 'activity', tag, phase: 'running' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.length).toBe(2);
    // A client never relays an `activity` frame of its own to anyone but the agent.
    c.send({ type: 'activity', tag, phase: 'done' });
    expect((await agent.next()).type).toBe('c');
  });

  it('pushes the card to each phone at its level, and starts one only where none is up', async () => {
    const pushes: { token: string; push: CardPush; app?: string }[] = [];
    const pushSender: PushSender = { enabled: true, send: async () => {}, sendCard: async (token, push, app) => void pushes.push({ token, push, app }) };
    const { url, rooms } = await startRelay({ pushSender });
    const agent = await connect(url, { room: 'r8', role: 'agent', key: 'k' });
    const c = await connect(url, { room: 'r8', role: 'client', key: 'k' });
    await c.next();
    await agent.next();
    const [minimal, detailed, starter] = ['1', '2', '3'].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    const tok = (ch: string) => ch.repeat(64);
    const names = { computerId: 'mac-1', computerName: 'Studio' };
    c.send({ type: 'register-card', deviceId: minimal, token: tok('a'), level: 'minimal', ...names });
    c.send({ type: 'register-card', deviceId: detailed, token: tok('b'), startToken: tok('c'), level: 'detailed', app: 'dev.nekkolabs.nekkoagent', ...names });
    c.send({ type: 'register-card', deviceId: starter, startToken: tok('d'), level: 'standard', ...names });
    // Malformed registrations are ignored.
    c.send({ type: 'register-card', deviceId: 'nope', token: tok('e'), level: 'standard' });
    c.send({ type: 'register-card', deviceId: minimal.replace('1', '9'), token: tok('e'), level: 'loud' });
    c.send({ type: 'register-card', deviceId: minimal.replace('1', '8'), token: 'not hex!', level: 'standard' });
    c.send({ type: 'register-card', deviceId: minimal.replace('1', '7'), level: 'standard' });
    await new Promise((r) => setTimeout(r, 50));
    expect([...rooms.get('r8')!.cards.keys()]).toEqual([minimal, detailed, starter]);

    const chat = { id: 's1', short: 'Fix', state: 'working', step: 'Run npm test', reply: 'On it.', closeWord: 'Cool' };
    agent.send({ type: 'card', state: { chats: [chat], focusId: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.map((p) => [p.token, p.push.event, p.push.state.chats[0].step, p.push.state.chats[0].reply])).toEqual([
      [tok('a'), 'update', '', ''],
      [tok('b'), 'update', 'Run npm test', 'On it.'],
    ]);
    expect(pushes[1].app).toBe('dev.nekkolabs.nekkoagent');

    // A run a phone asked for: an update where a card is up, a start where none is (once).
    pushes.length = 0;
    agent.send({ type: 'card-start', state: { chats: [chat], focusId: 's1' } });
    agent.send({ type: 'card-start', state: { chats: [chat], focusId: 's1' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.map((p) => [p.token, p.push.event])).toEqual([
      [tok('a'), 'update'],
      [tok('b'), 'update'],
      [tok('d'), 'start'],
      [tok('a'), 'update'],
      [tok('b'), 'update'],
    ]);
    const start = pushes[2].push;
    expect(start.attributes).toEqual({ ...names, level: 'standard' });
    expect(start.state.chats[0]).toMatchObject({ step: 'Run npm test', reply: '' });

    // An empty card ends it and forgets the update token; the start token stays.
    pushes.length = 0;
    agent.send({ type: 'card', state: { chats: [] } });
    agent.send({ type: 'card', state: 'junk' });
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.map((p) => [p.token, p.push.event])).toEqual([
      [tok('a'), 'end'],
      [tok('b'), 'end'],
    ]);
    expect(rooms.get('r8')!.cards.get(detailed)).toMatchObject({ startToken: tok('c') });
    expect(rooms.get('r8')!.cards.get(detailed)!.token).toBeUndefined();
    expect(rooms.get('r8')!.cards.has(minimal)).toBe(false);

    // Level none, and a revoked phone, drop the registration.
    c.send({ type: 'register-card', deviceId: starter, level: 'none' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r8')!.cards.has(starter)).toBe(false);
    agent.send({ type: 'push-remove', deviceId: detailed });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r8')!.cards.size).toBe(0);
    // A client's own `card` frame only ever reaches the agent.
    c.send({ type: 'card', state: { chats: [chat] } });
    expect((await agent.next()).type).toBe('c');
  });

  it('stores push tokens per device, pushes when offline, and removes on revoke', async () => {
    const sent: string[] = [];
    const pushSender: PushSender = { enabled: true, send: async (token) => void sent.push(token) };
    const { url, rooms } = await startRelay({ pushSender });
    const agent = await connect(url, { room: 'r5', role: 'agent', key: 'k' });
    const c = await connect(url, { room: 'r5', role: 'client', key: 'k' });
    await c.next();
    await agent.next();
    c.send({ type: 'register-push', token: 'abcdefghijklmnopqrstuvwxyz', platform: 'ios', deviceId: '00000000-0000-4000-8000-000000000001' });
    // Re-register replaces, not duplicates.
    c.send({ type: 'register-push', token: 'zyxwvutsrqponmlkjihgfedcba', platform: 'ios', deviceId: '00000000-0000-4000-8000-000000000001' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r5')!.pushTokens.get('00000000-0000-4000-8000-000000000001')!.token).toBe('zyxwvutsrqponmlkjihgfedcba');

    const other = await connect(url, { room: 'r5', role: 'client', key: 'k' });
    await other.next();
    await agent.next();
    other.send({ type: 'register-push', token: 'aaaaaaaaaaaaaaaaaaaa', platform: 'ios', deviceId: '00000000-0000-4000-8000-000000000001' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r5')!.pushTokens.get('00000000-0000-4000-8000-000000000001')!.token).toBe('zyxwvutsrqponmlkjihgfedcba');
    other.ws.close();
    await agent.next();

    // Clients connected → notify does not push.
    agent.send({ type: 'notify', title: 't', body: 'b' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);

    c.ws.close();
    await agent.next(); // client-close
    agent.send({ type: 'notify', title: 't', body: 'b' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual(['zyxwvutsrqponmlkjihgfedcba']);

    agent.send({ type: 'push-remove', deviceId: '00000000-0000-4000-8000-000000000001' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r5')!.pushTokens.size).toBe(0);
  });

  it('pushes only the kinds a phone asked for, a test to that phone, and dismissals', async () => {
    const sent: Array<{ token: string; kind?: string; tag?: string }> = [];
    const dismissed: Array<{ token: string; tag: string }> = [];
    const pushSender: PushSender = {
      enabled: true,
      delivers: (p) => p === 'ios',
      send: async (token, _platform, payload) => void sent.push({ token, kind: payload.kind, tag: payload.tag }),
      sendDismiss: async (token, tag) => void dismissed.push({ token, tag }),
    };
    const { url, rooms } = await startRelay({ pushSender });
    const agent = await connect(url, { room: 'r8', role: 'agent', key: 'k' });
    const a = await connect(url, { room: 'r8', role: 'client', key: 'k' });
    await a.next();
    await agent.next();
    const b = await connect(url, { room: 'r8', role: 'client', key: 'k' });
    await b.next();
    await agent.next();
    const devA = '00000000-0000-4000-8000-00000000000a';
    const devB = '00000000-0000-4000-8000-00000000000b';
    // A wants only needs-you (an unknown kind is dropped); B, an older phone, sends no kinds.
    a.send({ type: 'register-push', token: 'a'.repeat(64), platform: 'ios', deviceId: devA, kinds: ['needs-you', 'bogus', 'needs-you'] });
    expect(await a.next()).toEqual({ type: 'push-registered', delivers: true });
    b.send({ type: 'register-push', token: 'b'.repeat(40), platform: 'android', deviceId: devB });
    expect(await b.next()).toEqual({ type: 'push-registered', delivers: false });
    expect(rooms.get('r8')!.pushTokens.get(devA)!.kinds).toEqual(['needs-you']);
    expect(rooms.get('r8')!.pushTokens.get(devB)!.kinds).toBeUndefined();

    // A test goes to the asking phone even while it is connected, and to no one else.
    agent.send({ type: 'notify', kind: 'test', deviceId: devA, title: 'Nekko Agent', body: 'Test' });
    agent.send({ type: 'notify', kind: 'test', deviceId: 'nobody', title: 'x', body: 'y' });
    // Connected phones get no other push.
    agent.send({ type: 'notify', kind: 'needs-you', tag: 'c'.repeat(32), title: 't', body: 'b' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([{ token: 'a'.repeat(64), kind: 'test', tag: undefined }]);

    // A dismissal reaches connected phones as is, and iPhones that want needs-you as a silent push.
    const tag = 'd'.repeat(32);
    agent.send({ type: 'dismiss', tag });
    agent.send({ type: 'dismiss', tag: 'not a tag' });
    expect(await a.next()).toEqual({ type: 'dismiss', tag });
    expect(await b.next()).toEqual({ type: 'dismiss', tag });
    await new Promise((r) => setTimeout(r, 50));
    expect(dismissed).toEqual([{ token: 'a'.repeat(64), tag }]);

    a.ws.close();
    b.ws.close();
    await agent.next();
    await agent.next();
    sent.length = 0;
    agent.send({ type: 'notify', kind: 'needs-you', tag: 'e'.repeat(32), title: 't', body: 'b' });
    agent.send({ type: 'notify', kind: 'finished', title: 't', body: 'b' });
    // An older agent's notify has no kind: a finished run.
    agent.send({ type: 'notify', title: 't', body: 'b' });
    agent.send({ type: 'notify', kind: 'failed', tag: 'short', title: 't', body: 'b' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([
      { token: 'a'.repeat(64), kind: 'needs-you', tag: 'e'.repeat(32) },
      { token: 'b'.repeat(40), kind: 'needs-you', tag: 'e'.repeat(32) },
      { token: 'b'.repeat(40), kind: 'finished', tag: undefined },
      { token: 'b'.repeat(40), kind: 'finished', tag: undefined },
      { token: 'b'.repeat(40), kind: 'failed', tag: undefined },
    ]);
  });

  it('accepts FCM-shaped push tokens (with a colon) from Android phones', async () => {
    const { url, rooms } = await startRelay({ pushSender: { enabled: true, send: async () => {} } });
    const agent = await connect(url, { room: 'r6', role: 'agent', key: 'k' });
    const c = await connect(url, { room: 'r6', role: 'client', key: 'k' });
    await c.next();
    await agent.next();
    const fcm = 'dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ';
    c.send({ type: 'register-push', token: fcm, platform: 'android', deviceId: '00000000-0000-4000-8000-000000000002' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.get('r6')!.pushTokens.get('00000000-0000-4000-8000-000000000002')?.token).toBe(fcm);
  });

  it('gates agent enrollment behind the authz URL when configured', async () => {
    // Mock cloud authorizer: accepts only "good-token".
    const authz = createServer((req, res) => {
      const ok = req.headers.authorization === 'Bearer good-token';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
    httpServers.push(authz);
    await new Promise<void>((r) => authz.listen(0, '127.0.0.1', r));
    const authzUrl = `http://127.0.0.1:${(authz.address() as AddressInfo).port}/authorize`;

    const { url, rooms } = await startRelay({ authzUrl });
    const denied = await connect(url, { room: 'r6', role: 'agent', key: 'k' });
    expect((await denied.closed).code).toBe(4003);
    const deniedBad = await connect(url, { room: 'r6', role: 'agent', key: 'k', access: 'bad' });
    expect((await deniedBad.closed).code).toBe(4003);
    expect((await deniedBad.closed).reason).toContain('NEKKO_RELAY_AUTHZ_URL');

    const agent = await connect(url, { room: 'r6', role: 'agent', key: 'k', access: 'good-token' });
    while (!rooms.get('r6')?.agent) await new Promise((r) => setTimeout(r, 10));
    const c = await connect(url, { room: 'r6', role: 'client', key: 'k' });
    expect(await c.next()).toEqual({ type: 'agent-online' });
    expect((await agent.next()).type).toBe('client-open');
  });

  it('explains when unauthenticated enrollment is disabled', async () => {
    const { url } = await startRelay({ allowUnauthenticated: false });
    const denied = await connect(url, { room: 'r7', role: 'agent', key: 'k' });
    expect((await denied.closed).reason).toContain('NEKKO_RELAY_ALLOW_UNAUTHENTICATED');
  });
});
