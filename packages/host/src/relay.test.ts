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
    // The HELLO reply and one frame per delta (the relay-only `activity` frame aside).
    await vi.waitFor(() => expect(ws.sent.filter((raw) => JSON.parse(raw).type === 'd').length).toBe(1 + deltas.length));
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

  const sessions: Record<string, unknown> = {};

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
      getSession: (sid: string) => sessions[sid] ?? null,
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

  it('opens a chat too large for one relay frame, sending its newest part', async () => {
    // 400 tool results with a 30 KB screenshot each: ~16 MB as stored, far over the relay's frame.
    sessions.huge = {
      id: 'huge',
      title: 'Long agent run',
      messages: Array.from({ length: 400 }, (_, i) => ({
        id: `t${i}`, role: 'tool', content: '', toolResult: { toolCallId: `c${i}`, output: 'o'.repeat(9000), images: [{ data: 'A'.repeat(30_000) }] },
      })),
    };
    const { call, handle } = await phone();
    const res = await call('session:get', 'huge');
    expect(res.error).toBeUndefined();
    expect(res.result.omittedMessages).toBe(100);
    expect(res.result.messages).toHaveLength(300);
    expect(res.result.messages[0].toolResult).toMatchObject({ omittedImages: 1, truncated: true, outputChars: 9000 });
    expect(res.result.messages[0].toolResult.images).toBeUndefined();
    handle.stop();
  });

  it('answers a reply too large for the relay with an error instead of silence', async () => {
    const { call, handle } = await phone();
    // Not a session object, so nothing trims it: ~9.6 MB as JSON, over the frame limit once sealed.
    sessions.raw = Array.from({ length: 1200 }, (_, i) => ({ id: `s${i}`, title: 'x'.repeat(8000) }));
    const res = await call('session:get', 'raw');
    expect(res.result).toBeUndefined();
    expect(res.error).toMatch(/^This reply is too large to send to a phone \(\d+\.\d MB\)\. Open it on the computer\.$/);
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


describe('relay agent: connection failures', () => {
  /** A local TCP port that accepts and immediately drops: the WebSocket handshake fails. */
  async function droppingServer() {
    const net = await import('node:net');
    let accepted = 0;
    const server = net.createServer((s) => {
      accepted++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `ws://127.0.0.1:${port}`, accepted: () => accepted, close: () => server.close() };
  }

  it('survives a failed handshake with the real WebSocket and keeps retrying', async () => {
    // Before: onerror called close() while CONNECTING, undici fired `error` again
    // synchronously, and the process died with "Maximum call stack size exceeded".
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const relay = await droppingServer();
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    // Count `error` events per socket: the old handler re-entered hundreds of times.
    const errorsPerSocket: number[] = [];
    globalThis.WebSocket = class extends realWebSocket {
      constructor(url: string | URL) {
        super(url);
        const i = errorsPerSocket.push(0) - 1;
        this.addEventListener('error', () => errorsPerSocket[i]++);
      }
    } as typeof WebSocket;
    try {
      const handle = connectRelayAgent({ events: new EventEmitter() } as unknown as Host, {
        relayUrl: relay.url,
        room: ROOM,
        key: KEY,
        verify: () => ({ type: 'denied', reason: 'unknown-device' }) as any,
      });
      await vi.waitFor(() => expect(handle.lastError()).toBeTruthy(), { timeout: 3000 });
      expect(handle.isOnline()).toBe(false);
      expect(relay.accepted()).toBe(1);
      // A failed handshake never fires `close`; the retry must come anyway.
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(relay.accepted()).toBe(2), { timeout: 3000 });
      await vi.waitFor(() => expect(errorsPerSocket[1]).toBe(1), { timeout: 3000 });
      // One error per failed socket: nothing re-enters the failure path.
      expect(errorsPerSocket).toEqual([1, 1]);
      handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(relay.accepted()).toBe(2); // stop() ends the retries
      expect(errorsPerSocket).toEqual([1, 1]); // and leaves a socket that already failed alone
      expect(crashes).toEqual([]);
    } finally {
      process.off('uncaughtException', onCrash);
      relay.close();
      vi.useRealTimers();
    }
  });

  it('schedules one retry per lost connection, even when error and close both fire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
      const handle = connectRelayAgent({ events: new EventEmitter() } as unknown as Host, {
        relayUrl: 'ws://relay.test',
        room: ROOM,
        key: KEY,
        verify: () => ({ type: 'denied', reason: 'unknown-device' }) as any,
      });
      const first = FakeSocket.last!;
      first.onerror?.();
      first.onclose?.({ code: 1006, reason: '' });
      expect(handle.lastError()).toBe('could not reach the relay');
      await vi.advanceTimersByTimeAsync(2000);
      const second = FakeSocket.last!;
      expect(second).not.toBe(first);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeSocket.last).toBe(second); // the duplicate event did not schedule a second retry
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
