import { describe, expect, it } from 'vitest';
import { checkPackageEntries, MOD_PERMISSIONS, PACKAGE_MAX_BYTES, parsePackageManifest } from './nekko-package.js';

const MOD = {
  format: 1,
  kind: 'mod',
  id: 'com.example.gpu-wall',
  name: 'GPU wall',
  version: '1.2.0',
  description: 'Big GPU dials',
  author: { name: 'Ada', url: 'https://example.com' },
  license: 'MIT',
  engines: { 'nekko-agent': '>=0.9.0' },
  platforms: ['desktop'],
  permissions: ['hardware:read'],
  network: { hosts: [] },
  contributes: {
    panels: [{ id: 'gpu-wall', label: 'GPU wall', slots: ['board.pane', 'main'], entry: 'panel.html' }],
    monitors: [],
    commands: [{ id: 'gpu-wall.open', label: 'Open GPU wall', shortcut: null }],
    themes: [],
    settings: null,
  },
  main: null,
  layout: null,
  customization: null,
};

const errorsOf = (raw: unknown) => {
  const r = parsePackageManifest(raw);
  return r.ok ? [] : r.errors;
};

describe('parsePackageManifest', () => {
  it('accepts a full mod manifest', () => {
    const r = parsePackageManifest(MOD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.contributes.panels[0].entry).toBe('panel.html');
  });

  it('parses a JSON string and reports bad JSON', () => {
    expect(parsePackageManifest(JSON.stringify(MOD)).ok).toBe(true);
    expect(errorsOf('{nope')).toEqual(['nekko.json is not valid JSON']);
  });

  it('names each missing required field once', () => {
    for (const key of ['kind', 'id', 'version'] as const) {
      const { [key]: _, ...rest } = MOD;
      expect(errorsOf(rest)).toHaveLength(1);
    }
  });

  it('rejects unknown permissions, reserved ids and non-semver versions', () => {
    expect(errorsOf({ ...MOD, permissions: ['root'] })).toHaveLength(1);
    expect(errorsOf({ ...MOD, id: 'nekko.simple' })).toHaveLength(1);
    expect(errorsOf({ ...MOD, id: 'Not An Id' })).toHaveLength(1);
    expect(errorsOf({ ...MOD, version: '1.2' })).toHaveLength(1);
  });

  it('ties network hosts to the network permission', () => {
    expect(errorsOf({ ...MOD, permissions: ['network'], network: { hosts: [] } })).toHaveLength(1);
    expect(errorsOf({ ...MOD, network: { hosts: ['api.example.com'] } })).toHaveLength(1);
    expect(errorsOf({ ...MOD, permissions: ['network'], network: { hosts: ['api.example.com'] } })).toEqual([]);
    expect(errorsOf({ ...MOD, permissions: ['network'], network: { hosts: ["evil.com; script-src *"] } })).toHaveLength(1);
  });

  it('refuses contributions in a customization', () => {
    expect(errorsOf({ ...MOD, kind: 'customization', permissions: [], customization: {} })).not.toEqual([]);
  });

  it('checks contribution entries stay inside the package', () => {
    const panels = [{ ...MOD.contributes.panels[0], entry: '../x.html' }];
    expect(errorsOf({ ...MOD, contributes: { ...MOD.contributes, panels } })).toHaveLength(1);
  });

  it('never pollutes prototypes and rejects huge strings', () => {
    const r = parsePackageManifest(`{"__proto__":{"polluted":1},${JSON.stringify(MOD).slice(1)}`);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(errorsOf({ ...MOD, description: 'x'.repeat(10_001) })).toHaveLength(1);
  });

  it('never throws on junk', () => {
    for (const junk of [null, 1, [], 'null', { contributes: 5 }, { ...MOD, contributes: { panels: [null] } }]) {
      expect(parsePackageManifest(junk).ok).toBe(false);
    }
  });
});

describe('checkPackageEntries', () => {
  const ok = [{ path: 'nekko.json', size: 100 }, { path: 'panel.html', size: 100 }];

  it('accepts a normal mod', () => {
    expect(checkPackageEntries(ok, 'mod')).toEqual([]);
    expect(MOD_PERMISSIONS).toContain('tools:run');
  });

  it('rejects escapes, absolute paths and symlinks', () => {
    for (const path of ['../x', 'a/../../x', '/x', 'C:/x', 'a\\..\\x', 'a/./b', 'a\nb']) {
      expect(checkPackageEntries([...ok, { path, size: 1 }], 'mod')).toHaveLength(1);
    }
    expect(checkPackageEntries([...ok, { path: 'l', size: 1, symlink: true }], 'mod')).toHaveLength(1);
  });

  it('rejects oversized packages, a missing manifest and code in a customization', () => {
    expect(checkPackageEntries([...ok, { path: 'big.bin', size: PACKAGE_MAX_BYTES }], 'mod')).toHaveLength(1);
    expect(checkPackageEntries([{ path: 'panel.html', size: 1 }], 'mod')).toHaveLength(1);
    expect(checkPackageEntries([...ok, { path: 'x.js', size: 1 }], 'customization')).not.toEqual([]);
  });
});
