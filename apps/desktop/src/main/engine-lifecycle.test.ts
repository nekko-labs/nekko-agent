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

describe('a daemon that never comes up', () => {
  it('passes the config on stdin, never in the environment', () => {
    const first = child(); mocked.spawn.mockReturnValue(first);
    let written = '';
    first.stdin.on('data', (d) => { written += d; });
    const engine = new EngineProcess(options);
    engine.start();
    const [, args, opts] = mocked.spawn.mock.calls[0];
    expect(args).toEqual(['--config-stdin']);
    expect(opts.env.NEKKOD_CONFIG).toBeUndefined();
    return new Promise<void>((done) => setImmediate(() => {
      const line = written.split('\n')[0];
      expect(JSON.parse(line)).toMatchObject({ dataDir: '/data', edition: 'desktop' });
      expect(line).toContain('"token"');
      done();
    }));
  });

  it('fails waiters at once when the binary cannot be spawned, and Restart tries again', async () => {
    const broken = child(); mocked.spawn.mockReturnValueOnce(broken);
    const engine = new EngineProcess(options);
    engine.start();
    const waiting = expect(engine.endpoint()).rejects.toThrow('EACCES');
    // Node 26: 'error' and 'close', never 'exit', and no pid.
    broken.emit('error', Object.assign(new Error('spawn /bin/nekkod EACCES'), { code: 'EACCES' }));
    broken.emit('close', -13, null);
    await waiting;
    await expect(engine.endpoint()).rejects.toThrow('could not be started');
    // Nothing is left holding start() or stop().
    const later = child(); mocked.spawn.mockReturnValueOnce(later);
    engine.start();
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    later.stdout.write('NEKKOD_READY {"port":5151}\n');
    expect((await engine.endpoint()).url).toBe('http://127.0.0.1:5151');
    const final = engine.stop(); later.emit('exit', 0, null); await final;
  });

  it('kills a daemon that never prints its ready line and restarts it with backoff', async () => {
    vi.useFakeTimers();
    const wedged = child(); const next = child();
    mocked.spawn.mockReturnValueOnce(wedged).mockReturnValueOnce(next);
    const engine = new EngineProcess({ ...options, readyTimeoutMs: 1000 });
    engine.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(wedged.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(wedged.kill).toHaveBeenCalledWith('SIGTERM');
    // Still not gone: SIGKILL follows.
    await vi.advanceTimersByTimeAsync(3000);
    expect(wedged.kill).toHaveBeenLastCalledWith('SIGKILL');
    wedged.emit('exit', null, 'SIGKILL');
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    next.stdout.write('NEKKOD_READY {"port":6161}\n');
    await vi.advanceTimersByTimeAsync(5000);
    expect(next.kill).not.toHaveBeenCalled();
    expect((await engine.endpoint()).url).toBe('http://127.0.0.1:6161');
    const final = engine.stop(); next.emit('exit', 0, null); await final;
  });

  it('says another engine holds the data folder instead of restarting into it', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start();
    const waiting = expect(engine.endpoint()).rejects.toThrow('already running on this data folder');
    first.emit('exit', 3, null);
    await waiting;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });

  it('stops with stdin, then SIGTERM, then SIGKILL, and resolves only once it exited', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start();
    first.stdout.write('NEKKOD_READY {"port":1}\n');
    let stopped = false;
    const stopping = engine.stop(1000).then(() => { stopped = true; });
    expect(first.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(3000);
    expect(first.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(stopped).toBe(false);
    first.emit('exit', null, 'SIGKILL');
    await stopping;
    expect(stopped).toBe(true);
  });
});

