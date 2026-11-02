import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modCsp, resolveModPath } from './modPolicy';

describe('modCsp', () => {
  it('blocks the network unless the mod holds the permission', () => {
    expect(modCsp({ permissions: [], network: { hosts: ['api.example.com'] } })).toContain("connect-src 'none'");
    expect(modCsp({ permissions: ['network'], network: { hosts: ['api.example.com', 'x.io:8443'] } }))
      .toContain('connect-src https://api.example.com https://x.io:8443;');
  });

  it('drops hosts that could inject policy', () => {
    const csp = modCsp({ permissions: ['network'], network: { hosts: ["evil.com; script-src *", 'a b', "c'd"] } });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('evil');
  });

  it('never allows inline or remote script', () => {
    expect(modCsp({ permissions: [], network: { hosts: [] } })).toMatch(/default-src 'none'; script-src 'self';/);
  });
});

describe('resolveModPath', () => {
  const root = '/data/mods';

  it('maps a file inside the mod folder', () => {
    expect(resolveModPath(root, 'nekko-mod://com.example.gpu/panel.html')).toBe(join(root, 'com.example.gpu', 'panel.html'));
    expect(resolveModPath(root, 'nekko-mod://com.example.gpu/assets/a%20b.png')).toBe(join(root, 'com.example.gpu', 'assets', 'a b.png'));
  });

  it('keeps .. and %2e%2e inside the folder, since the URL parser resolves them first', () => {
    expect(resolveModPath(root, 'nekko-mod://com.example.gpu/a/../../x')).toBe(join(root, 'com.example.gpu', 'x'));
    expect(resolveModPath(root, 'nekko-mod://com.example.gpu/%2e%2e/%2E%2E/x')).toBe(join(root, 'com.example.gpu', 'x'));
  });

  it('refuses escapes, bad ids, other schemes and the package metadata', () => {
    for (const url of [
      'nekko-mod://com.example.gpu/a%2F..%2F..%2Fx',
      'nekko-mod://com.example.gpu/a%5C..%5Cx',
      'nekko-mod://com.example.gpu/%2Fetc%2Fpasswd',
      'nekko-mod://Com.Example.Gpu/panel.html',
      'nekko-mod://nogood/panel.html',
      'nekko-mod://com.example.gpu/',
      'nekko-mod://com.example.gpu/nekko.json',
      'nekko-mod://com.example.gpu/SIGNATURES',
      'file:///etc/passwd',
      'nekko-mod://com.example.gpu/%E0%A4%A',
    ]) expect(resolveModPath(root, url), url).toBeNull();
  });
});
