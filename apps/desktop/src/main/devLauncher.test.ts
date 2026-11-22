import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const launcher = '../../scripts/dev-launch.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('development launcher safety', () => {
  it('refuses to start when Electron would run as plain Node', async () => {
    // Exercise the native .mjs loader, not two cold Vite imports (which can
    // spend the whole safety-test budget waiting on transform RPC under CI load).
    // Importing is safe: the launcher's argv/main guard never spawns Electron.
    // Fail if an import touches Electron: its lazy binary install downloads on
    // require in CI, where ELECTRON_SKIP_BINARY_DOWNLOAD skips npm's install.
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(id, ...args) {
        if (id === 'electron') throw new Error('Electron must not be resolved on plain import');
        return load.call(this, id, ...args);
      };
      import(${JSON.stringify(new URL(launcher, import.meta.url).href)})`;
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 2000,
    });
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('Unset ELECTRON_RUN_AS_NODE');
    const allowed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `${script}.then(mod => console.log(JSON.stringify([typeof mod.prepareWindowsRuntime, typeof mod.prepareMacBundle])))`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, encoding: 'utf8', timeout: 2000,
    });
    expect(allowed.error).toBeUndefined();
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual(['function', 'function']);
  });

  it('rebuilds the cached runtime when the app icon changes', async () => {
    const { runtimeStamp, runtimeIsCurrent } = await import(/* @vite-ignore */ launcher);
    const dir = mkdtempSync(join(tmpdir(), 'nekko-runtime-'));
    const icon = join(dir, 'icon.ico'), ready = join(dir, 'ready-v1');
    writeFileSync(icon, 'old logo');
    const old = runtimeStamp(icon, 'patched');
    expect(runtimeIsCurrent(ready, old)).toBe(false); // nothing built yet
    writeFileSync(ready, old);
    expect(runtimeIsCurrent(ready, runtimeStamp(icon, 'patched'))).toBe(true); // same icon: reuse
    writeFileSync(icon, 'new logo');
    expect(runtimeIsCurrent(ready, runtimeStamp(icon, 'patched'))).toBe(false); // new icon: rebuild
    writeFileSync(ready, 'patched'); // a copy cached before icons were stamped
    expect(runtimeIsCurrent(ready, runtimeStamp(icon, 'patched'))).toBe(false);
  });

  it('prints a banner once the app reports in, naming the API, renderer, data folder and how to stop', async () => {
    // @ts-expect-error plain .mjs without types
    const { devBanner } = await import('../../scripts/dev-banner.mjs');
    const text: string = devBanner({ version: '0.8.0', pid: 42, api: { url: 'http://127.0.0.1:1439', enabled: true }, renderer: 'http://localhost:5173', dataDir: 'C:\\Users\\p\\.nekko-agent' });
    expect(text).toContain('Nekko Agent 0.8.0 is running (pid 42)');
    expect(text).toContain('http://127.0.0.1:1439');
    expect(text).toContain('http://localhost:5173');
    expect(text).toContain('.nekko-agent');
    expect(text).toMatch(/q.*Enter.*stop cleanly/);
    expect(text).toMatch(/r\s+restart with what is on disk/);
    expect(text).not.toContain('\x1b[');
    const off: string = devBanner({ api: { url: 'http://127.0.0.1:1439', enabled: false } });
    expect(off).toContain('(off: switch it on in Settings > Server)');
  });
});

describe('development launcher status line', () => {
  const at = 1_000_000;
  const base = { now: at, startedAt: at - 14_000, frame: 0, columns: 100 };
  const line = async (s: object) => {
    // @ts-expect-error plain .mjs without types
    const { statusLine } = await import('../../scripts/dev-status.mjs');
    return statusLine({ ...base, ...s }) as string;
  };

  it('says it is starting until the app first reports in', async () => {
    expect(await line({})).toContain('Starting Nekko Agent... 14s');
  });

  it('counts the working chats by phase, and says idle with a sleeping cat when none are', async () => {
    const busy = await line({ report: { at, activity: { building: 2, verifying: 1, input: 1 } } });
    expect(busy).toContain('( o.o ) Building 2 · Verifying 1 · 1 waiting on you');
    expect(busy).toMatch(/q stop · r restart$/);
    const idle = await line({ report: { at, activity: { building: 0, verifying: 0, input: 0 } } });
    expect(idle).toContain('( -.- ) Idle');
    expect(idle).not.toContain('Building');
  });

  it('warns once the heartbeat stops, instead of spinning on', async () => {
    const text = await line({ now: at + 12_000, report: { at, activity: { building: 1, verifying: 0 } } });
    expect(text).toContain('No word from the app for 12s: it may be frozen');
    expect(text).not.toContain('Building');
  });

  it('keeps a stop in progress on the line, from the launcher or from the app quitting', async () => {
    const own = await line({ now: at + 3_000, stoppingSince: at, report: { at: at + 2_500, activity: { building: 1, verifying: 0 } } });
    expect(own).toContain('Stopping cleanly... 3s');
    expect(own).toMatch(/q again to force$/);
    expect(await line({ report: { at, quitting: true, activity: null } })).toContain('Stopping cleanly...');
  });

  it('names a window that stopped responding and an engine that does not answer', async () => {
    expect(await line({ report: { at, activity: { building: 1, verifying: 0 }, unresponsive: 1 } })).toContain('a window is not responding');
    expect(await line({ report: { at, activity: null } })).toContain('The engine is not answering');
  });

  it('fits the terminal width and has no colour codes unless asked', async () => {
    const narrow = await line({ columns: 30, report: { at, activity: { building: 12, verifying: 3, input: 2 } } });
    expect([...narrow].length).toBeLessThanOrEqual(30);
    expect(narrow).not.toContain('\x1b[');
    expect(await line({ color: true, report: { at, activity: { building: 1, verifying: 0 } } })).toContain('\x1b[');
  });

  it('pins the line under a scroll region and gives the terminal back on close', async () => {
    // @ts-expect-error plain .mjs without types
    const { pinnedLine } = await import('../../scripts/dev-status.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'nekko-status-'));
    const file = join(dir, 'tty');
    writeFileSync(file, '');
    const { openSync, closeSync } = await import('node:fs');
    const fd = openSync(file, 'a');
    const handlers: (() => void)[] = [];
    const out = { fd, rows: 40, columns: 100, on: (_e: string, f: () => void) => handlers.push(f), off: () => {} };
    const pin = pinnedLine(out);
    pin.draw(' hello');
    out.rows = 30; handlers[0]();
    pin.close();
    closeSync(fd);
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('\x1b[1;39r');
    expect(written).toContain('\x1b7\x1b[40;1H\x1b[2K hello\x1b8');
    expect(written).toContain('\x1b[1;29r'); // resized: the region follows
    expect(written).toContain('\x1b[30;1H\x1b[2K hello'); // and the line is drawn again
    expect(written.endsWith('\x1b7\x1b[r\x1b[30;1H\x1b[2K\x1b8')).toBe(true);
  });
});

/**
 * Still source checks: this wiring sits in the script's top-level `if (main)`
 * block and spawns Electron, so it cannot run in a unit test without moving it
 * into exported functions in scripts/dev-launch.mjs (see the PR's Unfinished
 * work). Kept so the guarantees stay pinned until then.
 */
describe('development launcher wiring (source checks until the launcher is refactored)', () => {
  const source = readFileSync(new URL(launcher, import.meta.url), 'utf8');
  it('copies a versioned private runtime with relative framework symlinks preserved', () => {
    expect(source).toContain("require('electron/package.json').version");
    expect(source).toContain('verbatimSymlinks: true');
    expect(source).toContain("'Nekko Agent.app'");
  });
  it('runs a Windows dev build as a branded "Nekko Agent.exe", not electron.exe', () => {
    expect(source).toContain("join(cache, 'Nekko Agent.exe')");
    expect(source).toContain("FileDescription: 'Nekko Agent'");
    expect(source).toContain("resolve('build/icon.ico')");
    expect(source).toContain('env.ELECTRON_EXEC_PATH = await prepareWindowsRuntime()');
  });
  it('makes a bare launch of the Windows dev runtime reopen Nekko Agent, not an empty Electron window', () => {
    // Notification clicks and its Start Menu entry start the runtime with no app path.
    expect(source).toContain("join(cache, 'resources', 'app')");
    expect(source).toContain("cpSync(resolve('scripts/dev-runtime-app.cjs'), join(dir, 'index.cjs'))");
    expect(source.match(/return installRuntimeApp\(cache, exe\)/g)).toHaveLength(2);
    const shim = readFileSync(new URL('../../scripts/dev-runtime-app.cjs', import.meta.url), 'utf8');
    expect(shim).toContain("join(process.resourcesPath, 'default_app.asar', 'main.js')");
    expect(shim).toContain('spawn(process.execPath, [appDir]');
  });
  it('uses LaunchServices and a distinct development bundle identity', () => {
    expect(readFileSync(new URL('../../scripts/dev-launch-wrapper.cjs', import.meta.url), 'utf8')).toContain("'/usr/bin/open'");
    expect(source).toContain('com.nekkoagent.desktop.dev');
    expect(source).toContain('env.ELECTRON_EXEC_PATH = prepared.launcher');
  });
  it('stops cleanly from the keyboard and force-kills the whole tree only as a fallback', () => {
    expect(source).toContain("key === '\\r'");
    expect(source).toContain("key.toLowerCase() === 'q'");
    expect(source).toContain('env.NEKKO_DEV_STOP_FILE = stopFile');
    expect(source).toContain("'/T', '/F'");
    expect(source).toContain('process.kill(-child.pid');
  });
  it('restarts the whole of npm run dev on r, after the same clean stop', () => {
    expect(source).toContain("key.toLowerCase() === 'r' && !stopping");
    expect(source).toContain("spawnSync('npm', ['run', 'dev'], { cwd: resolve('../..')");
  });
  it('tells the app where to report in for the banner', () => {
    expect(source).toContain('env.NEKKO_DEV_READY_FILE = readyFile');
  });
  it('tells the app where to write its heartbeat, and closes the pinned line before exiting or restarting', () => {
    expect(source).toContain('env.NEKKO_DEV_STATUS_FILE = statusFile');
    expect(source).toContain("process.env.NEKKO_DEV_STATUS !== 'off'");
    expect(source.indexOf('pinned?.close()')).toBeGreaterThan(source.indexOf('const cleanup = () => {'));
  });
  it('leaves user privacy grants alone', () => {
    expect(source).not.toContain('tccutil');
  });
});
