import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineProcess } from './engine-process.js';
import { ENGINE_ENDPOINT_CHANNEL, SERVICE_CONTROL_CHANNEL } from '../engineChannels.js';
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {}, ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } }));
vi.mock('./update.js', () => ({ initUpdater: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() }));
import { registerIpc } from './ipc.js';
const event = { sender: { id: 42, getURL: () => 'http://localhost:5173' } };
afterEach(() => { handlers.clear(); vi.restoreAllMocks(); });
describe('shell service controls', () => {
  it('logs stopped requests with their window and operation, without invoking a throwing endpoint', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const engine = { running: false, endpoint: vi.fn() };
    registerIpc(engine as unknown as EngineProcess);
    expect(await handlers.get(ENGINE_ENDPOINT_CHANNEL)!(event, 'settings:get')).toBeNull();
    expect(engine.endpoint).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('renderer 42 (http://localhost:5173): settings:get'));
  });
  it('preserves real startup failures', async () => {
    registerIpc({ running: true, endpoint: vi.fn().mockRejectedValue(new Error('startup failed')) } as unknown as EngineProcess);
    await expect(handlers.get(ENGINE_ENDPOINT_CHANNEL)!(event)).rejects.toThrow('startup failed');
  });
  it('can start and restart the stopped agent through shell IPC', async () => {
    const engine = { running: false, stop: vi.fn(async () => { engine.running = false; }), start: vi.fn(() => { engine.running = true; }), endpoint: vi.fn().mockResolvedValue({}), call: vi.fn().mockResolvedValue({ running: false, install: { binPath: '/model' } }) };
    registerIpc(engine as unknown as EngineProcess);
    const control = handlers.get(SERVICE_CONTROL_CHANNEL)!;
    expect(await control(event, 'status')).toEqual({ agentRunning: false, modelRunning: false, modelAvailable: false });
    expect(engine.call).not.toHaveBeenCalled();
    expect((await control(event, 'start')).agentRunning).toBe(true);
    await control(event, 'restart');
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(engine.start).toHaveBeenCalledTimes(2);
    await expect(control(event, 'invalid')).rejects.toThrow('Unknown service action');
  });
});
