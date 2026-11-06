import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildRelay, type RelayLimits } from './server.js';
import type { PushPayload, PushSender } from './push.js';

const sockets: WebSocket[] = [];
const apps: { close(): Promise<void> }[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const tag = (n: number) => n.toString(16).padStart(32, '0');
const device = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const token = 'a'.repeat(64);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

async function harness(extra: Partial<PushSender> = {}, limits: Partial<RelayLimits> = {}) {
  const alerts: { token: string; platform: string; payload: PushPayload; app?: string }[] = [];
  const badges: { token: string; badge: number; app?: string }[] = [];
  const dismissals: { token: string; tag: string; badge?: number }[] = [];
  const sender: PushSender = {
    enabled: true,
    apnsTopic: (app) => app === 'dev.other' ? app : 'dev.default',
    send: async (token, platform, payload, app) => { alerts.push({ token, platform, payload, app }); },
    sendBadge: async (token, badge, app) => { badges.push({ token, badge, app }); },
    sendDismiss: async (token, tag, _app, badge) => { dismissals.push({ token, tag, badge }); },
    ...extra,
  };
  const { app, rooms } = buildRelay({ allowUnauthenticated: true, pushSender: sender, limits: { rateBurst: 10_000, ...limits } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app);
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/relay`;
  async function connect(room: string, role: 'agent' | 'client', proto?: string) {
    const socket = new WebSocket(`${url}?${new URLSearchParams({ room, role, key: 'test-key', ...(proto ? { proto } : {}) })}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return { socket, send: (frame: unknown) => socket.send(JSON.stringify(frame)) };
  }
  async function pair(room: string, badgeRooms: string[] | null = [room], n = 1, app?: string) {
    const agent = await connect(room, 'agent');
    const phone = await connect(room, 'client');
    phone.send({ type: 'register-push', deviceId: device(n), token, platform: 'ios', badgeRooms: badgeRooms ?? undefined, app });
    await expect.poll(() => rooms.get(room)?.pushTokens.size).toBe(1);
    return { agent, phone, room };
  }
  return { rooms, alerts, badges, dismissals, connect, pair };
}

describe('relay authoritative attention badges', () => {
  it('counts distinct chats per room across a canonical token/topic, not reminders or duplicate registrations, and reaches zero', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a', 'b'], 1, 'dev.unlisted-alias');
    const b = await h.pair('b', ['b', 'a'], 1);
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1), tag(1)] });
    await tick();
    expect(h.badges).toEqual([]);
    b.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(2);
    // Same physical target registered under another device id is not counted twice.
    const duplicate = await h.connect('a', 'client');
    duplicate.send({ type: 'register-push', deviceId: device(2), token: token.toUpperCase(), platform: 'ios', badgeRooms: ['a', 'b'] });
    await expect.poll(() => h.rooms.get('a')?.pushTokens.size).toBe(2);
    expect(h.badges.at(-1)?.badge).toBe(2);
    a.phone.socket.close();
    duplicate.socket.close();
    await expect.poll(() => h.rooms.get('a')?.clients.size).toBe(0);
    a.agent.send({ type: 'notify', kind: 'needs-you', tag: tag(1), title: 'SECRET title', body: 'SECRET tool input' });
    a.agent.send({ type: 'notify', kind: 'needs-you', tag: tag(1) });
    await expect.poll(() => h.alerts.length).toBe(2);
    expect(h.alerts.map((p) => p.payload.badge)).toEqual([2, 2]);
    expect(JSON.stringify(h.alerts)).not.toContain('SECRET');
    expect(h.alerts[0].payload).toMatchObject({ title: 'Nekko Agent', body: 'Your computer needs your attention.' });
    a.agent.send({ type: 'activity', phase: 'question', tag: tag(2) });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(3);
    expect(h.rooms.get('a')?.activities.size).toBe(0);
    a.agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.at(-1)?.badge).toBe(2);
    a.agent.send({ type: 'activity', phase: 'running', tag: tag(2) });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    b.agent.send({ type: 'notify', kind: 'finished', tag: tag(1) });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(0);
    b.agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.at(-1)?.badge).toBe(0);
    a.agent.send({ type: 'notify', kind: 'test', deviceId: device(1) });
    await expect.poll(() => h.alerts.length).toBe(3);
    expect(h.alerts.at(-1)?.payload).not.toHaveProperty('badge');
    expect(h.rooms.get('a')?.attention.size).toBe(0);
  });

  it('sends legacy alerts and dismissals without a badge until both snapshot and membership are known', async () => {
    const h = await harness();
    const { agent, phone } = await h.pair('legacy', null);
    phone.socket.close();
    await expect.poll(() => h.rooms.get('legacy')?.clients.size).toBe(0);
    agent.send({ type: 'notify', kind: 'needs-you', tag: tag(1) });
    await expect.poll(() => h.alerts.length).toBe(1);
    expect(h.alerts[0].payload).not.toHaveProperty('badge');
    agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.length).toBe(1);
    expect(h.dismissals[0].badge).toBeUndefined();
    expect(h.badges).toEqual([]);
    agent.send({ type: 'attention-snapshot', tags: [] });
    await tick();
    expect(h.badges).toEqual([]); // A room snapshot cannot prove app-wide membership.
  });

  it('does not assert partial or zero counts after restart when a manifest room has not re-registered', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a', 'offline']);
    a.agent.send({ type: 'attention-snapshot', tags: [] });
    await tick();
    expect(h.badges).toEqual([]);
    const b = await h.pair('offline', ['a', 'offline']);
    a.agent.send({ type: 'activity', phase: 'approval', tag: tag(1) });
    await tick();
    expect(h.badges).toEqual([]); // Present registration, but missing snapshot.
    b.agent.send({ type: 'attention-snapshot', tags: [tag(2)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(2);
  });

  it('invalidates on disconnect and replacement, retains offline membership, and recovers only with a fresh full snapshot', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a', 'b']);
    const b = await h.pair('b', ['a', 'b']);
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    b.agent.send({ type: 'attention-snapshot', tags: [tag(2)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(2);
    b.phone.socket.close();
    await expect.poll(() => h.rooms.get('b')?.clients.size).toBe(0);
    b.agent.socket.close();
    await expect.poll(() => h.rooms.get('b')?.agent).toBeNull();
    const count = h.badges.length;
    a.agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.length).toBe(1);
    expect(h.dismissals[0].badge).toBeUndefined();
    expect(h.badges.length).toBe(count);
    const next = await h.connect('b', 'agent');
    next.send({ type: 'activity', phase: 'question', tag: tag(3) });
    await tick();
    expect(h.badges.length).toBe(count);
    next.send({ type: 'attention-snapshot', tags: [] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(0);
    const replacement = await h.connect('b', 'agent');
    await tick();
    expect(h.rooms.get('b')?.attentionKnown).toBe(false);
    replacement.send({ type: 'attention-snapshot', tags: [tag(4)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    await tick();
    expect(h.rooms.get('b')?.attentionKnown).toBe(true); // Old socket's late close cannot invalidate its successor.
  });

  it.each(['bad-tag', 'oversized', 'unknown', 'delta-overflow', 'untagged'] as const)('fails closed on %s and recovers with a complete empty snapshot', async (failure) => {
    const h = await harness();
    const { agent } = await h.pair('a');
    const full = Array.from({ length: 4096 }, (_, i) => tag(i));
    agent.send({ type: 'attention-snapshot', tags: failure === 'delta-overflow' ? full : [tag(1)] });
    await expect.poll(() => h.badges.length).toBe(1);
    if (failure === 'bad-tag') agent.send({ type: 'attention-snapshot', tags: [tag(1), 'not-a-tag'] });
    if (failure === 'oversized') agent.send({ type: 'attention-snapshot', tags: [...full, tag(4096)] });
    if (failure === 'unknown') agent.send({ type: 'attention-unknown' });
    if (failure === 'delta-overflow') agent.send({ type: 'activity', phase: 'approval', tag: tag(4096) });
    if (failure === 'untagged') agent.send({ type: 'notify', kind: 'needs-you' });
    await expect.poll(() => h.rooms.get('a')?.attentionKnown).toBe(false);
    agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.length).toBe(1);
    expect(h.dismissals[0].badge).toBeUndefined();
    expect(h.badges.length).toBe(1);
    agent.send({ type: 'attention-snapshot', tags: [] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(0);
  });

  it('clears opt-out with a complete empty manifest, respects kinds, and never treats a conflicting manifest as complete', async () => {
    const h = await harness();
    const a = await h.pair('a');
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    a.phone.send({ type: 'register-push', deviceId: device(1), token, platform: 'ios', kinds: ['finished'], badgeRooms: [] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(0);
    a.phone.socket.close();
    await expect.poll(() => h.rooms.get('a')?.clients.size).toBe(0);
    a.agent.send({ type: 'notify', kind: 'needs-you', tag: tag(2) });
    a.agent.send({ type: 'notify', kind: 'finished', tag: tag(3) });
    await expect.poll(() => h.alerts.length).toBe(1);
    expect(h.alerts[0].payload).toMatchObject({ kind: 'finished', badge: 0 });
    const b = await h.pair('b', ['b']); // A's old registration still declares [] for the same target.
    b.agent.send({ type: 'attention-snapshot', tags: [tag(4)] });
    await tick();
    expect(h.badges.at(-1)?.badge).toBe(0);
  });

  it('removes only an opted-out room once every registration agrees on the remaining manifest', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a', 'b']);
    const b = await h.pair('b', ['a', 'b']);
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    b.agent.send({ type: 'attention-snapshot', tags: [tag(2)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(2);
    const register = (phone: typeof a.phone, kinds: string[], badgeRooms: string[]) =>
      phone.send({ type: 'register-push', deviceId: device(1), token, platform: 'ios', kinds, badgeRooms });
    register(a.phone, [], ['b']);
    await expect.poll(() => h.rooms.get('a')?.pushTokens.get(device(1))?.kinds).toEqual([]);
    expect(h.badges.at(-1)?.badge).toBe(2); // Inconsistent manifest cannot publish a subtotal.
    register(b.phone, ['needs-you'], ['b']);
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    register(b.phone, [], []);
    register(a.phone, [], []);
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(0);
  });

  it('separates topics for the same token and fails closed on legacy or malformed manifests', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a']);
    const b = await h.pair('b', ['b'], 1, 'dev.other');
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    b.agent.send({ type: 'attention-snapshot', tags: [tag(2), tag(3)] });
    await expect.poll(() => h.badges.length).toBe(2);
    expect(h.badges.map((p) => p.badge).sort()).toEqual([1, 2]);
    a.phone.send({ type: 'register-push', deviceId: device(1), token, platform: 'ios', badgeRooms: ['a', 7] });
    await expect.poll(() => h.rooms.get('a')?.pushTokens.get(device(1))?.badgeRooms).toBeUndefined();
    a.agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.length).toBe(1);
    expect(h.dismissals[0].badge).toBeUndefined();
  });

  it.each([false, true])('suppresses only the connected device, not other phones or any-client (gated=%s)', async (gated) => {
    const h = await harness();
    const agent = await h.connect('a', 'agent', gated ? '6' : undefined);
    const online = await h.connect('a', 'client');
    const offline = await h.connect('a', 'client');
    await expect.poll(() => h.rooms.get('a')?.clients.size).toBe(2);
    const [cidOnline, cidOffline] = [...h.rooms.get('a')!.clients.keys()];
    if (gated) {
      agent.send({ type: 'welcomed', cid: cidOnline, deviceId: device(1) });
      agent.send({ type: 'welcomed', cid: cidOffline, deviceId: device(2) });
      await expect.poll(() => h.rooms.get('a')?.welcomed.size).toBe(2);
    }
    online.send({ type: 'register-push', deviceId: device(1), token, platform: 'ios' });
    offline.send({ type: 'register-push', deviceId: device(2), token: 'b'.repeat(64), platform: 'ios' });
    await expect.poll(() => h.rooms.get('a')?.pushTokens.size).toBe(2);
    offline.socket.close();
    await expect.poll(() => h.rooms.get('a')?.clients.size).toBe(1);
    // Even a register-card on the live connection must not change its identity for suppression.
    online.send({ type: 'register-card', deviceId: device(1), token, level: 'minimal' });
    agent.send({ type: 'notify', kind: 'needs-you', tag: tag(1) });
    await expect.poll(() => h.alerts.length).toBe(1);
    expect(h.alerts.map((p) => p.token)).toEqual(['b'.repeat(64)]);
    online.socket.close();
    await expect.poll(() => h.rooms.get('a')?.clients.size).toBe(0);
    await h.connect('a', 'client'); // Unidentified socket does not suppress either registered device.
    agent.send({ type: 'notify', kind: 'needs-you', tag: tag(2) });
    await expect.poll(() => h.alerts.length).toBe(3);
  });

  it('invalidates a complete set when rate limiting could drop a delta', async () => {
    const h = await harness({}, { rateBurst: 3, ratePerSec: 0 });
    const { agent } = await h.pair('a');
    agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    agent.send({ type: 'ignored' });
    agent.send({ type: 'ignored' });
    agent.send({ type: 'dismiss', tag: tag(1) }); // Dropped: the relay cannot know the new set.
    await expect.poll(() => h.rooms.get('a')?.attentionKnown).toBe(false);
    expect(h.badges.at(-1)?.badge).toBe(1); // No invented zero.
  });

  it('does not let a client snapshot establish authority, or revocation invent a reduced count', async () => {
    const h = await harness();
    const a = await h.pair('a', ['a', 'b']);
    const b = await h.pair('b', ['a', 'b']);
    a.phone.send({ type: 'attention-snapshot', tags: [] });
    b.agent.send({ type: 'attention-snapshot', tags: [] });
    await tick();
    expect(h.rooms.get('a')?.attentionKnown).toBe(false);
    expect(h.badges).toEqual([]);
    a.agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    await expect.poll(() => h.badges.at(-1)?.badge).toBe(1);
    const count = h.badges.length;
    b.agent.send({ type: 'push-remove', deviceId: device(1) });
    await expect.poll(() => h.rooms.get('b')?.pushTokens.size).toBe(0);
    a.agent.send({ type: 'dismiss', tag: tag(1) });
    await expect.poll(() => h.dismissals.length).toBe(1);
    expect(h.dismissals[0].badge).toBeUndefined();
    expect(h.badges.length).toBe(count); // Phone must refresh the complete membership first.
  });

  it('rechecks authority at submission time and serializes queued updates behind an in-flight request', async () => {
    let release!: () => void;
    const submitted: number[] = [];
    const h = await harness({ sendBadge: async (_token, badge) => {
      submitted.push(badge);
      if (submitted.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    } });
    const { agent } = await h.pair('a');
    agent.send({ type: 'attention-snapshot', tags: [tag(1)] });
    await expect.poll(() => submitted).toEqual([1]);
    try {
      agent.send({ type: 'activity', phase: 'question', tag: tag(2) });
      agent.send({ type: 'attention-unknown' });
      await expect.poll(() => h.rooms.get('a')?.attentionKnown).toBe(false);
      expect(submitted).toEqual([1]);
    } finally { release(); }
    await tick();
    expect(submitted).toEqual([1]); // The queued count of 2 was invalidated before submission.
    agent.send({ type: 'attention-snapshot', tags: [] });
    await expect.poll(() => submitted).toEqual([1, 0]);
  });
});
