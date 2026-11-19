import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDevLaunch, reportDevStatus } from './devLaunchProcess.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
describe('owned development launch receipt', () => {
  it('stops its registered app and removes only its own receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
    const file = join(dir, 'receipt.json');
    vi.stubEnv('NEKKO_DEV_PID_FILE', file); vi.stubEnv('NEKKO_DEV_LAUNCH_TOKEN', 'owned-token'); vi.stubEnv('NEKKO_DEV_OWNER', 'owned-parent');
    let finish = () => {};
    const quit = vi.fn();
    const before = new Set(process.listeners('SIGTERM'));
    registerDevLaunch({ quit, on: (_event, handler) => { finish = handler; } });
    const stop = process.listeners('SIGTERM').find(handler => !before.has(handler))!;
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, token: 'owned-token', owner: 'owned-parent' });
    stop('SIGTERM'); expect(quit).toHaveBeenCalledOnce();
    finish(); expect(existsSync(file)).toBe(false); expect(process.listeners('SIGTERM')).not.toContain(stop);
  });
  it('quits cleanly once the launcher drops its stop file, and stops watching on quit', () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
      const stopFile = join(dir, 'stop');
      vi.stubEnv('NEKKO_DEV_STOP_FILE', stopFile);
      const quit = vi.fn();
      registerDevLaunch({ quit, on: () => {} });
      vi.advanceTimersByTime(1000);
      expect(quit).not.toHaveBeenCalled();
      writeFileSync(stopFile, 'stop');
      vi.advanceTimersByTime(300);
      expect(quit).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1000);
      expect(quit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('preserves a replacement receipt during cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
    const file = join(dir, 'receipt.json');
    vi.stubEnv('NEKKO_DEV_PID_FILE', file); vi.stubEnv('NEKKO_DEV_LAUNCH_TOKEN', 'first');
    let finish = () => {};
    registerDevLaunch({ quit: vi.fn(), on: (_event, handler) => { finish = handler; } });
    writeFileSync(file, JSON.stringify({ pid: 123, token: 'replacement' }));
    finish(); expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('replacement');
  });
});

describe('development status heartbeat', () => {
  const window = () => {
    const on: Record<string, () => void> = {};
    return { on: (e: string, f: () => void) => { on[e] = f; }, fire: (e: string) => on[e]() };
  };
  it('writes nothing outside npm run dev', () => {
    vi.stubEnv('NEKKO_DEV_STATUS_FILE', '');
    const activity = vi.fn();
    reportDevStatus({ activity, quitting: () => false }, { on: () => {} }, [])();
    expect(activity).not.toHaveBeenCalled();
  });
  it('writes what the agents are doing every second, quitting, and windows that stopped responding', async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-status-test-')); dirs.push(dir);
      const file = join(dir, 'status');
      vi.stubEnv('NEKKO_DEV_STATUS_FILE', file);
      let quitting = false;
      let created: (e: unknown, w: ReturnType<typeof window>) => void = () => {};
      const first = window();
      const stop = reportDevStatus(
        { activity: async () => ({ building: 2, verifying: 1, input: 0 }), quitting: () => quitting },
        { on: (_e, f) => { created = f as typeof created; } },
        [first],
      );
      await vi.advanceTimersByTimeAsync(0);
      const read = () => JSON.parse(readFileSync(file, 'utf8'));
      expect(read()).toMatchObject({ quitting: false, activity: { building: 2, verifying: 1, input: 0 }, unresponsive: 0 });
      const later = window();
      created(null, later);
      first.fire('unresponsive'); later.fire('unresponsive');
      await vi.advanceTimersByTimeAsync(1000);
      expect(read().unresponsive).toBe(2);
      first.fire('responsive'); later.fire('closed');
      quitting = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(read()).toMatchObject({ quitting: true, activity: null, unresponsive: 0 });
      const at = read().at;
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(read().at).toBe(at); // stopped: the beat goes quiet
    } finally { vi.useRealTimers(); }
  });
  it('reports the engine as not answering when it is down or slow, and keeps beating', async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-status-test-')); dirs.push(dir);
      const file = join(dir, 'status');
      vi.stubEnv('NEKKO_DEV_STATUS_FILE', file);
      const stop = reportDevStatus({ activity: () => new Promise(() => {}), quitting: () => false }, { on: () => {} }, []);
      await vi.advanceTimersByTimeAsync(900);
      expect(JSON.parse(readFileSync(file, 'utf8')).activity).toBeNull();
      stop();
    } finally { vi.useRealTimers(); }
  });
});
