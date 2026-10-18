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
