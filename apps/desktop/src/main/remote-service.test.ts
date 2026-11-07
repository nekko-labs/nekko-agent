import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineProcess } from './engine-process.js';
import { SERVICE_CONTROL_CHANNEL } from '../engineChannels.js';
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } }));
import { registerIpc, shellBridge } from './ipc.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); handlers.clear(); });
function rig() {
  const calls: string[] = [];
  const engine = {
    running: true,
    stop: vi.fn(async () => { calls.push('stop'); engine.running = false; }),
    start: vi.fn(() => { calls.push('start'); engine.running = true; }),
    endpoint: vi.fn(async () => { calls.push('ready'); return { url: 'loopback', token: 'private' }; }),
  };
  let current: EngineProcess | null = engine as unknown as EngineProcess;
  const shell = shellBridge(vi.fn(), () => current);
  return { engine, calls, shell, clear: () => { current = null; } };
}

describe('remote supervised restart', () => {
  it('acknowledges first, stops once, starts only after stop and waits for readiness', async () => {
    vi.useFakeTimers();
    const r = rig();
    expect(r.shell.serviceStatus!()).toEqual({ protocolVersion: 1, agentRunning: true, restart: true, updateInstall: true });
    expect(r.shell.serviceRestart!()).toEqual({ restarting: true });
    expect(r.calls).toEqual([]);
    expect(r.shell.serviceStatus!().restart).toBe(false);
    expect(() => r.shell.serviceRestart!()).toThrow('service-busy');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.calls).toEqual(['stop', 'start', 'ready']);
    expect(r.shell.serviceStatus!().restart).toBe(true);
  });

  it('waits for graceful stop before start, even when stop takes time', async () => {
    vi.useFakeTimers();
    const r = rig();
    let stopped!: () => void;
    r.engine.stop.mockImplementation(() => new Promise<void>(resolve => { stopped = resolve; }));
    r.shell.serviceRestart!();
    await vi.advanceTimersByTimeAsync(300);
    expect(r.engine.stop).toHaveBeenCalledOnce();
    expect(r.engine.start).not.toHaveBeenCalled();
    stopped();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.engine.start).toHaveBeenCalledOnce();
    expect(r.engine.endpoint).toHaveBeenCalledOnce();
  });

  it('does not restart after app quit before the timer or during shutdown', async () => {
    vi.useFakeTimers();
    for (const duringStop of [false, true]) {
      const r = rig();
      if (duringStop) r.engine.stop.mockImplementation(async () => { r.clear(); });
      r.shell.serviceRestart!();
      if (!duringStop) r.clear();
      await vi.advanceTimersByTimeAsync(300);
      expect(r.engine.start).not.toHaveBeenCalled();
      expect(r.shell.serviceStatus!().restart).toBe(false);
    }
  });

  it('refuses absent/stopped supervisors and does not start after a failed stop', async () => {
    vi.useFakeTimers();
    expect(() => shellBridge(vi.fn()).serviceRestart!()).toThrow('service-unavailable');
    const r = rig();
    r.engine.running = false;
    expect(() => r.shell.serviceRestart!()).toThrow('service-unavailable');
    r.engine.running = true;
    r.engine.stop.mockRejectedValueOnce(new Error('shutdown failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.shell.serviceRestart!();
    await vi.advanceTimersByTimeAsync(300);
    expect(r.engine.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Remote service restart failed', expect.any(Error));
    expect(r.shell.serviceStatus!().restart).toBe(true);
  });

  it('makes restart and install reservations mutually exclusive', async () => {
    vi.useFakeTimers();
    const restarting = rig();
    restarting.shell.serviceRestart!();
    expect(() => restarting.shell.servicePrepareInstall!()).toThrow('service-busy');
    await vi.advanceTimersByTimeAsync(300);
    const installing = rig();
    expect(installing.shell.servicePrepareInstall!()).toEqual({ prepared: true });
    expect(installing.shell.serviceStatus!().restart).toBe(false);
    expect(installing.shell.serviceStatus!().updateInstall).toBe(false);
    expect(() => installing.shell.serviceRestart!()).toThrow('service-busy');
    expect(() => installing.shell.servicePrepareInstall!()).toThrow('service-busy');
    await vi.advanceTimersByTimeAsync(1000);
    expect(installing.calls).toEqual([]);
    installing.clear();
    expect(() => installing.shell.servicePrepareInstall!()).toThrow('service-unavailable');
  });

  it('shares its action lock with local shell controls', async () => {
    vi.useFakeTimers();
    const r = rig();
    registerIpc(r.engine as unknown as EngineProcess, () => true);
    const mainFrame = {};
    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    r.shell.serviceRestart!();
    await expect(handlers.get(SERVICE_CONTROL_CHANNEL)!(event, 'restart')).rejects.toThrow('already in progress');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.engine.stop).toHaveBeenCalledOnce();
  });
});
