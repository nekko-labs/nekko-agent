import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcEvents, deriveKey, open, seal } from '@nekko-agent/shared';
import { connectRelayAgent } from './relay.js';
import type { Host } from './host.js';

/** Minimal WebSocket stand-in: records what the agent writes to the relay. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const ROOM = 'a1b2c3d4e5f60718';
const KEY = '00112233445566778899aabbccddeeff';
const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

async function welcomedAgent(methods: Record<string, unknown> = {}) {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const events = new EventEmitter();
  const host = { events, ...methods } as unknown as Host;
  const handle = connectRelayAgent(host, {
    relayUrl: 'ws://relay.test',
    room: ROOM,
    key: KEY,
    verify: (hello: any) => ({ type: 'welcome', device: { id: hello.deviceId, name: 'Phone', platform: 'android', createdAt: 0, lastSeenAt: 0 } }),
  });
  const ws = FakeSocket.last!;
  const key = await deriveKey(KEY, ROOM);
  ws.deliver({ type: 'client-open', cid: 'c1' });
  ws.deliver({ type: 'c', cid: 'c1', data: JSON.stringify({ enc: await seal(key, { type: 'hello', deviceId: 'd1' }) }) });
  await vi.waitFor(() => expect(ws.sent.length).toBe(1)); // the welcome
  return { handle, ws, events, key };
}

async function framesFor(ws: FakeSocket, key: CryptoKey, cid: string) {
  const out: any[] = [];
  for (const raw of ws.sent) {
    const env = JSON.parse(raw);
    if (env.type === 'd' && env.cid === cid) out.push(await open(key, JSON.parse(env.data).enc));
  }
  return out;
}

describe('relay agent', () => {
  it('delivers streamed events to a phone in the order they were emitted', async () => {
    const { handle, ws, events, key } = await welcomedAgent();
    // A long first delta seals slower than the short ones after it.
    const deltas = ['x'.repeat(200_000), 'Hello ', 'from ', 'your ', 'computer.'];
    for (const delta of deltas) events.emit('agentEvent', { type: 'text', sessionId: 's', delta });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1 + deltas.length));
    const frames = (await framesFor(ws, key, 'c1')).filter((f) => f.type === 'event');
    expect(frames.every((f) => f.channel === IpcEvents.agentEvent)).toBe(true);
    expect(frames.map((f) => f.payload.delta)).toEqual(deltas);
    handle.stop();
  });

  it('never sends events to a connection that has not completed HELLO', async () => {
    const { handle, ws, events, key } = await welcomedAgent();
    ws.deliver({ type: 'client-open', cid: 'stranger' });
    events.emit('agentEvent', { type: 'text', sessionId: 's', delta: 'secret' });
    await vi.waitFor(() => expect(ws.sent.length).toBe(2));
    expect(await framesFor(ws, key, 'stranger')).toEqual([]);
    handle.stop();
  });
});

describe('relay agent: what a phone may do', () => {
  const SETTINGS = {
    theme: 'dark', defaultModelId: 'm1', defaultChatMode: 'ask', sandboxMode: 'workspace', hfToken: 'hf_secret',
    providers: [{ id: 'p1', kind: 'openai', label: 'GPT', apiKey: 'sk-secret', enabled: true }],
    voice: { enabled: true, language: 'en', modelPath: '/m.bin' },
  };

  async function phone() {
    const saved: unknown[] = [];
    const wipe = vi.fn();
    const host = {
      getSettings: () => SETTINGS,
      updateSettings: (patch: object) => {
        saved.push(patch);
        return { ...SETTINGS, ...patch };
      },
      wipeAllData: wipe,
      listSessionSummaries: () => [{ id: 's1' }],
    };
    const agent = await welcomedAgent(host);
    let id = 0;
    const call = async (channel: string, ...args: unknown[]) => {
      const rid = ++id;
      agent.ws.deliver({ type: 'c', cid: 'c1', data: JSON.stringify({ enc: await seal(agent.key, { type: 'req', id: rid, channel, args }) }) });
      let res: any;
      await vi.waitFor(async () => {
        res = (await framesFor(agent.ws, agent.key, 'c1')).find((f) => f.type === 'res' && f.id === rid);
        expect(res).toBeDefined();
      });
      return res;
    };
    return { ...agent, call, saved, wipe };
  }

  it('refuses channels off the allowlist before the host runs them', async () => {
    const { call, wipe, handle } = await phone();
    for (const channel of ['data:wipe', 'settings:reset', 'remote:rotate', 'terminal:create', 'file:write', 'tasks:list']) {
      expect((await call(channel)).error).toBe(`Not allowed from a paired phone (channel-denied): ${channel}`);
    }
    expect(wipe).not.toHaveBeenCalled();
    handle.stop();
  });

  it('still serves an allowed channel', async () => {
    const { call, handle } = await phone();
    expect(await call('sessions:summaries')).toMatchObject({ result: [{ id: 's1' }] });
    handle.stop();
  });

  it('refuses other settings, applying nothing, and allows YOLO', async () => {
    const { call, saved, handle } = await phone();
    expect((await call('settings:update', { chatPaneAction: 'delete', sandboxMode: 'off' })).error).toMatch(/setting-denied\): sandboxMode/);
    expect((await call('settings:update', { defaultChatMode: 'turbo' })).error).toMatch(/value-invalid/);
    expect(saved).toEqual([]);
    expect((await call('settings:update', { defaultChatMode: 'yolo' })).error).toBeUndefined();
    expect(saved).toEqual([{ defaultChatMode: 'yolo' }]);
    saved.length = 0;
    const ok = await call('settings:update', { chatPaneAction: 'delete' });
    expect(saved).toEqual([{ chatPaneAction: 'delete' }]);
    expect(ok.result.chatPaneAction).toBe('delete');
    handle.stop();
  });

  it('returns settings without secrets', async () => {
    const { call, handle } = await phone();
    const { result } = await call('settings:get');
    expect(result).toEqual({ theme: 'dark', defaultModelId: 'm1', defaultChatMode: 'ask', voice: { enabled: true, language: 'en' } });
    handle.stop();
  });
});

