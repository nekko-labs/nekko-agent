import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../scripts/dev-launch.mjs', import.meta.url), 'utf8');
describe('development launcher safety', () => {
  it('copies a versioned private runtime with relative framework symlinks preserved', () => {
    expect(source).toContain("require('electron/package.json').version");
    expect(source).toContain('verbatimSymlinks: true');
    expect(source).toContain("'Nekko Agent.app'");
  });
  it('uses LaunchServices and a distinct development bundle identity', () => {
    expect(readFileSync(new URL('../../scripts/dev-launch-wrapper.cjs', import.meta.url), 'utf8')).toContain("'/usr/bin/open'");
    expect(source).toContain('com.nekkoagent.desktop.dev');
    expect(source).toContain("env.ELECTRON_EXEC_PATH = prepared.launcher");
  });
  it('stops cleanly from the keyboard and force-kills the whole tree only as a fallback', () => {
    expect(source).toContain("key === '\\r'");
    expect(source).toContain("key.toLowerCase() === 'q'");
    expect(source).toContain('env.NEKKO_DEV_STOP_FILE = stopFile');
    expect(source).toContain("'/T', '/F'");
    expect(source).toContain('process.kill(-child.pid');
  });
  it('prints a banner once the app reports in, naming the API, renderer, data folder and how to stop', async () => {
    expect(source).toContain('env.NEKKO_DEV_READY_FILE = readyFile');
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
  it('rejects node-mode Electron and leaves user privacy grants alone', () => {
    expect(source).toContain('Unset ELECTRON_RUN_AS_NODE');
    expect(source).not.toContain('tccutil');
  });
});
