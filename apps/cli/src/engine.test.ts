import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnv, DaemonProcess, findNekkod, nekkodPackageName } from './engine.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'nekko-nekkod-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const touch = (p: string, mtime?: number) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
  if (mtime) utimesSync(p, mtime, mtime);
};

describe('nekkodPackageName', () => {
  it("names this platform's package, and the x64 one on Windows on Arm", () => {
    expect(nekkodPackageName('linux', 'arm64')).toBe('@nekko-agent/nekkod-linux-arm64');
    expect(nekkodPackageName('win32', 'arm64')).toBe('@nekko-agent/nekkod-win32-x64');
  });
});

describe('findNekkod', () => {
  const none = () => null;

  it('honours NEKKOD_PATH, and only when it exists', () => {
    const d = scratch();
    const bin = join(d, 'custom-nekkod');
    touch(bin);
    expect(findNekkod({ here: d, env: { NEKKOD_PATH: bin }, resolvePackage: none })).toEqual({ path: bin, source: 'NEKKOD_PATH' });
    expect(findNekkod({ here: d, env: { NEKKOD_PATH: join(d, 'missing') }, resolvePackage: none })).toBeNull();
  });

  it('prefers the platform npm package, then bin/ beside the script, then the newest cargo build', () => {
    const root = scratch();
    const here = join(root, 'apps/web-app-server/dist');
    const exe = 'nekkod';
    touch(join(root, 'target/release', exe), 1_000);
    touch(join(root, 'target/debug', exe), 2_000);
    const opts = { here, env: {}, platform: 'linux', arch: 'x64' };
    expect(findNekkod({ ...opts, resolvePackage: none })).toEqual({ path: join(root, 'target/debug', exe), source: 'cargo build' });

    touch(join(here, 'bin', exe));
    expect(findNekkod({ ...opts, resolvePackage: none })?.source).toBe('bundled');

    const pkg = join(root, 'node_modules/@nekko-agent/nekkod-linux-x64');
    touch(join(pkg, 'bin', exe));
    touch(join(pkg, 'package.json'));
    const resolvePackage = (name: string) => (name === nekkodPackageName('linux', 'x64') ? join(pkg, 'package.json') : null);
    expect(findNekkod({ ...opts, resolvePackage })).toEqual({ path: join(pkg, 'bin', exe), source: 'npm package' });
  });

  it("finds the installed app's daemon from the CLI the app ships (resources/cli -> resources/bin)", () => {
    const resources = scratch();
    touch(join(resources, 'bin', 'nekkod.exe'));
    expect(findNekkod({ here: join(resources, 'cli'), env: {}, platform: 'win32', resolvePackage: none })).toEqual({
      path: join(resources, 'cli', '..', 'bin', 'nekkod.exe'),
      source: 'app',
    });
  });

  it('looks for nekkod.exe on Windows and finds nothing in an empty tree', () => {
    const root = scratch();
    const here = join(root, 'apps/web-app-server/dist');
    expect(findNekkod({ here, env: {}, platform: 'win32', resolvePackage: none })).toBeNull();
    touch(join(root, 'target/release/nekkod.exe'));
    expect(findNekkod({ here, env: {}, platform: 'win32', resolvePackage: none })?.path).toBe(join(root, 'target/release/nekkod.exe'));
  });
});

describe('childEnv', () => {
  it('drops the public token and any daemon config', () => {
    const out = childEnv({ NEKKO_TOKEN: 'secret', NEKKOD_CONFIG: '{}', NEKKO_PORT: '1440', PATH: '/bin' });
    expect(out).toEqual({ NEKKO_PORT: '1440', PATH: '/bin' });
  });
});

