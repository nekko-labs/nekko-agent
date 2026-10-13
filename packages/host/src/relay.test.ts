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

async function welcomedAgent() {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const events = new EventEmitter();
  const host = { events } as unknown as Host;
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

  it('survives a refused dial without recursing, and reconnects once', async () => {
    vi.useFakeTimers();
    try {
      const sockets: ReentrantSocket[] = [];
      /** Mimics Node's WebSocket: close() while CONNECTING re-fires `error` synchronously. */
      class ReentrantSocket {
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onclose: ((ev: { code: number; reason: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        errors = 0;
        constructor(public url: string) {
          sockets.push(this);
        }
        send() {}
        close() {
          this.fail();
        }
        fail() {
          if (++this.errors > 50) throw new RangeError('Maximum call stack size exceeded');
          this.onerror?.();
        }
      }
      globalThis.WebSocket = ReentrantSocket as unknown as typeof WebSocket;
      const handle = connectRelayAgent({ events: new EventEmitter() } as unknown as Host, {
        relayUrl: 'ws://relay.test',
        room: ROOM,
        key: KEY,
        verify: () => ({ type: 'denied', reason: 'invalid' }),
      });
      expect(() => sockets[0].fail()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0); // the deferred close()
      expect(sockets[0].errors).toBeLessThanOrEqual(2);
      expect(handle.isOnline()).toBe(false);
      expect(handle.lastError()).toBe('relay connection failed');
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2); // exactly one reconnect
      sockets[1].onclose?.({ code: 1006, reason: '' }); // a later close on the new socket
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(3);
      handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sockets).toHaveLength(3); // stopped: no more dials
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects once when error and close both fire for the same socket', async () => {
    vi.useFakeTimers();
    try {
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
      const dials: string[] = [];
      const Counting = class extends FakeSocket {
        constructor(url: string) {
          super(url);
          dials.push(url);
        }
      };
      globalThis.WebSocket = Counting as unknown as typeof WebSocket;
      const handle = connectRelayAgent({ events: new EventEmitter() } as unknown as Host, {
        relayUrl: 'ws://relay.test',
        room: ROOM,
        key: KEY,
        verify: () => ({ type: 'denied', reason: 'invalid' }),
      });
      const first = FakeSocket.last!;
      first.onerror?.();
      first.onclose?.({ code: 1006, reason: 'gone' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(dials).toHaveLength(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
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
