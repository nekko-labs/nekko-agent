import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineSocket } from './engine-socket.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('stopped service transport', () => {
  it('rejects queued calls when the service endpoint is unavailable', async () => {
    vi.useFakeTimers();
    const api = createEngineSocket(() => Promise.reject(new Error('Service is stopped')));
    await expect(api.call('settings:get', [])).rejects.toThrow('stopped');
    vi.clearAllTimers();
  });
  it('handles a stopped endpoint response and reports queued request channels', async () => {
    vi.useFakeTimers();
    const endpoint = vi.fn().mockResolvedValue(null);
    const api = createEngineSocket(endpoint);
    await expect(api.call('settings:get', [])).rejects.toThrow('stopped');
    const call = expect(api.call('models:list', [])).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(100);
    await call;
    expect(endpoint).toHaveBeenLastCalledWith('models:list');
    expect(await api.openTerminal('term1', { onData: vi.fn() })).toBeNull();
    expect(endpoint).toHaveBeenLastCalledWith('terminal:term1');
    vi.clearAllTimers();
  });
  it('never replays calls that failed when a connection closed', async () => {
    vi.useFakeTimers();
    const sockets: any[] = [];
    class Socket {
      onopen?: () => void;
      onclose?: () => void;
      send = vi.fn();
      constructor() { sockets.push(this); }
    }
    vi.stubGlobal('WebSocket', Socket);
    const api = createEngineSocket(async () => ({ url: 'http://127.0.0.1:1', token: 'test' }));
    await Promise.resolve();
    const call = expect(api.call('sessions:create', [])).rejects.toThrow('restarted');
    sockets[0].onclose(); await call;
    await vi.advanceTimersByTimeAsync(100);
    sockets[1].onopen();
    expect(sockets[1].send).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });
});

describe('the heartbeat', () => {
  class Socket {
    static all: Socket[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (ev: { data: string }) => void;
    send = vi.fn();
    close = vi.fn();
    constructor() { Socket.all.push(this); }
  }
  const endpoint = async () => ({ url: 'http://127.0.0.1:1', token: 'test' });

  it('pings an open socket and keeps it while the engine answers, however long a call takes', async () => {
    vi.useFakeTimers();
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const api = createEngineSocket(endpoint, { pingMs: 1000, deadMs: 3000 });
    await Promise.resolve();
    const ws = Socket.all[0];
    ws.onopen!();
    let settled = false;
    void api.call('turn:run', []).then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      const ping = ws.send.mock.calls.map((c) => JSON.parse(c[0])).filter((f) => f.channel === 'daemon:ping').at(-1);
      expect(ping).toBeDefined();
      ws.onmessage!({ data: JSON.stringify({ id: ping.id, result: true }) });
    }
    expect(settled).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });

  it('gives up on a socket that goes silent: calls fail with a readable error and it reconnects', async () => {
    vi.useFakeTimers();
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const api = createEngineSocket(endpoint, { pingMs: 1000, deadMs: 3000 });
    await Promise.resolve();
    Socket.all[0].onopen!();
    const call = expect(api.call('settings:get', [])).rejects.toThrow('settings:get: the engine stopped responding');
    await vi.advanceTimersByTimeAsync(3000);
    await call;
    expect(Socket.all[0].close).toHaveBeenCalled();
    // The late close event of the dead socket changes nothing; a new socket is opened.
    Socket.all[0].onclose!();
    await vi.advanceTimersByTimeAsync(100);
    expect(Socket.all).toHaveLength(2);
    vi.clearAllTimers();
  });
});

