import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const launcher = '../../scripts/dev-launch.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('development launcher safety', () => {
  it('refuses to start when Electron would run as plain Node', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    await expect(import(/* @vite-ignore */ launcher)).rejects.toThrow('Unset ELECTRON_RUN_AS_NODE');
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '');
    vi.resetModules();
    const mod = await import(/* @vite-ignore */ launcher);
    expect(typeof mod.prepareWindowsRuntime).toBe('function');
    expect(typeof mod.prepareMacBundle).toBe('function');
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
    expect(text).not.toContain('\x1b[');
    const off: string = devBanner({ api: { url: 'http://127.0.0.1:1439', enabled: false } });
    expect(off).toContain('(off: switch it on in Settings > Server)');
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
  it('tells the app where to report in for the banner', () => {
    expect(source).toContain('env.NEKKO_DEV_READY_FILE = readyFile');
  });
  it('leaves user privacy grants alone', () => {
    expect(source).not.toContain('tccutil');
  });
});
