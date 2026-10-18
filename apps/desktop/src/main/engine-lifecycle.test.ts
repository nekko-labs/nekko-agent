import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
import { EngineProcess } from './engine-process.js';

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null });
}
const options = { dataDir: '/data', app: { isPackaged: false, appPath: '/missing', userData: '/u', version: '0' }, origins: ['null'], mainDir: '/main' };
// Any file that exists stands in for the daemon binary; spawn is mocked.
beforeEach(() => { vi.stubEnv('NEKKOD_PATH', process.execPath); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); mocked.spawn.mockReset(); });

describe('service lifecycle', () => {
  it('starts once, rejects waiters on stop and supports a fresh start', async () => {
    const first = child(); const second = child();
    mocked.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const engine = new EngineProcess(options);
    engine.start(); engine.start();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const waiting = expect(engine.endpoint()).rejects.toThrow('stopped');
    const stopped = engine.stop();
    first.emit('exit', 0, null);
    await stopped; await waiting;
    await expect(engine.endpoint()).rejects.toThrow('stopped');
    engine.start();
    second.stdout.write('NEKKOD_READY {"port":12345}\n');
    expect((await engine.endpoint()).url).toBe('http://127.0.0.1:12345');
    const final = engine.stop(); second.emit('exit', 0, null); await final;
  });
  it('manual stop cancels an already scheduled crash restart', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start(); first.emit('exit', 1, null);
    await engine.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(engine.running).toBe(false);
  });
  it('bounds startup waits and cannot restart while shutdown is incomplete', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start();
    const ready = expect(engine.endpoint()).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(15000); await ready;
    const stopping = engine.stop(); engine.start();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    first.emit('exit', 0, null); await stopping;
  });
});

describe('an engine that cannot run', () => {
  it('says nekkod is missing instead of running without it, and Restart looks again', async () => {
    vi.stubEnv('NEKKOD_PATH', '/no/such/nekkod');
    const engine = new EngineProcess(options);
    engine.start();
    expect(mocked.spawn).not.toHaveBeenCalled();
    await expect(engine.endpoint()).rejects.toThrow('nekkod is not built');
    expect(engine.running).toBe(true);
    const later = child(); mocked.spawn.mockReturnValue(later);
    vi.stubEnv('NEKKOD_PATH', process.execPath);
    engine.start();
    later.stdout.write('NEKKOD_READY {"port":4242}\n');
    expect((await engine.endpoint()).url).toBe('http://127.0.0.1:4242');
    const final = engine.stop(); later.emit('exit', 0, null); await final;
  });

  it('tells a packaged app to reinstall', async () => {
    vi.stubEnv('NEKKOD_PATH', '/no/such/nekkod');
    const engine = new EngineProcess({ ...options, app: { ...options.app, isPackaged: true } });
    engine.start();
    await expect(engine.endpoint()).rejects.toThrow('Reinstall Nekko Agent');
  });

  it('stops restarting a daemon Windows cannot load, and rejects waiters with why', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start();
    const waiting = expect(engine.endpoint()).rejects.toThrow('Visual C++');
    first.emit('exit', 0xc0000135, null);
    await waiting;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    await expect(engine.endpoint()).rejects.toThrow('Visual C++');
  });
});
