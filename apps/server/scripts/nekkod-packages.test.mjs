import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORMS, packageName, writePackages } from './nekkod-packages.mjs';
import { nekkodPackageName } from '../src/nekkod.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('nekkod npm packages', () => {
  it('names packages the way the server resolves them', () => {
    for (const [key, p] of Object.entries(PLATFORMS)) expect(packageName(key)).toBe(nekkodPackageName(p.os, p.cpu));
  });

  it('writes one package per built platform, binary and sidecars only, with os/cpu set', () => {
    const root = mkdtempSync(join(tmpdir(), 'nekkod-pkgs-'));
    dirs.push(root);
    const bins = join(root, 'bins');
    mkdirSync(join(bins, 'win32-x64'), { recursive: true });
    mkdirSync(join(bins, 'linux-x64'), { recursive: true });
    for (const f of ['nekkod.exe', 'DirectML.dll', 'nekkod.pdb']) writeFileSync(join(bins, 'win32-x64', f), 'x');
    for (const f of ['nekkod', 'nekkod.d']) writeFileSync(join(bins, 'linux-x64', f), 'x');

    const written = writePackages({ bins, out: join(root, 'out'), version: '1.2.3', log: () => {} });
    expect(written.map((w) => w.key)).toEqual(['win32-x64', 'linux-x64']);
    expect(readdirSync(join(root, 'out/win32-x64/bin')).sort()).toEqual(['DirectML.dll', 'nekkod.exe']);
    expect(readdirSync(join(root, 'out/linux-x64/bin'))).toEqual(['nekkod']);
    const pkg = JSON.parse(readFileSync(join(root, 'out/linux-x64/package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: '@nekko-agent/nekkod-linux-x64', version: '1.2.3', os: ['linux'], cpu: ['x64'], files: ['bin'] });
    if (process.platform !== 'win32') expect(statSync(join(root, 'out/linux-x64/bin/nekkod')).mode & 0o111).toBeTruthy();

    expect(() => writePackages({ bins, out: join(root, 'out2'), version: '1.2.3', requireAll: true, log: () => {} })).toThrow(/linux-arm64/);
  });
});
