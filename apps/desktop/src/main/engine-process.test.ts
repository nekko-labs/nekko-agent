import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDaemon } from './engine-process.js';

const app = (over: Partial<{ isPackaged: boolean; appPath: string; resourcesPath: string }> = {}) => ({
  app: { isPackaged: false, appPath: '/nowhere/apps/desktop', userData: '/u', version: '0', ...over },
});

describe('finding the engine daemon', () => {
  const saved = process.env.NEKKOD_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEKKOD_PATH;
    else process.env.NEKKOD_PATH = saved;
  });

  it('uses an explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekkod-find-'));
    const bin = join(dir, 'nekkod-custom');
    writeFileSync(bin, '');
    process.env.NEKKOD_PATH = bin;
    expect(findDaemon(app())).toBe(bin);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a packaged binary under resources/bin', () => {
    delete process.env.NEKKOD_PATH;
    const res = mkdtempSync(join(tmpdir(), 'nekkod-res-'));
    const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
    const bin = join(res, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, exe), '');
    expect(findDaemon(app({ isPackaged: true, resourcesPath: res }))).toBe(join(bin, exe));
    rmSync(res, { recursive: true, force: true });
  });

  it('picks the newer of the release and debug builds in a development checkout', () => {
    delete process.env.NEKKOD_PATH;
    const root = mkdtempSync(join(tmpdir(), 'nekkod-dev-'));
    const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
    const appPath = join(root, 'apps', 'desktop');
    const release = join(root, 'target', 'release', exe);
    const debug = join(root, 'target', 'debug', exe);
    for (const p of [appPath, join(root, 'target', 'release'), join(root, 'target', 'debug')]) mkdirSync(p, { recursive: true });
    writeFileSync(release, '');
    writeFileSync(debug, '');
    const older = new Date('2026-10-02T00:00:00Z');
    const newer = new Date('2026-10-03T00:00:00Z');

    // A stale release build must not shadow a fresh debug build.
    utimesSync(release, older, older);
    utimesSync(debug, newer, newer);
    expect(findDaemon(app({ appPath }))).toBe(debug);

    utimesSync(release, newer, newer);
    utimesSync(debug, older, older);
    expect(findDaemon(app({ appPath }))).toBe(release);

    // `npm run dev` builds the dev-daemon profile; a fresh one beats both.
    const devDaemon = join(root, 'target', 'dev-daemon', exe);
    mkdirSync(join(root, 'target', 'dev-daemon'), { recursive: true });
    writeFileSync(devDaemon, '');
    const newest = new Date('2026-10-04T00:00:00Z');
    utimesSync(devDaemon, newest, newest);
    expect(findDaemon(app({ appPath }))).toBe(devDaemon);
    rmSync(devDaemon);

    // Only one build present: that one.
    rmSync(release);
    expect(findDaemon(app({ appPath }))).toBe(debug);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports none rather than guessing, so the app falls back to the TS backend', () => {
    delete process.env.NEKKOD_PATH;
    expect(findDaemon(app())).toBeNull();
  });
});
