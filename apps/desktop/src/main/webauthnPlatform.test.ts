import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APPLE_TEAM_ID, WEBAUTHN_KEYCHAIN_ACCESS_GROUP, configurePlatformAuthenticator, platformAuthenticatorOptions } from './webauthnPlatform.js';

describe('the macOS platform authenticator', () => {
  it('asks for Touch ID on macOS and for nothing elsewhere', () => {
    expect(platformAuthenticatorOptions('darwin')).toEqual({
      touchID: { keychainAccessGroup: WEBAUTHN_KEYCHAIN_ACCESS_GROUP, promptReason: 'confirm it is you' },
    });
    expect(platformAuthenticatorOptions('win32')).toBeNull();
    expect(platformAuthenticatorOptions('linux')).toBeNull();
  });

  it('keeps the keychain group team-prefixed, and never asks for platform passkeys (no domain to associate)', () => {
    expect(WEBAUTHN_KEYCHAIN_ACCESS_GROUP.startsWith(`${APPLE_TEAM_ID}.`)).toBe(true);
    expect(platformAuthenticatorOptions('darwin')).not.toHaveProperty('platformPasskeys');
  });

  it('turns it on once, and survives an Electron that refuses or has not got the API', () => {
    const configureWebAuthn = vi.fn();
    expect(configurePlatformAuthenticator({ configureWebAuthn }, 'darwin')).toBe(true);
    expect(configureWebAuthn).toHaveBeenCalledWith(platformAuthenticatorOptions('darwin'));

    expect(configurePlatformAuthenticator({}, 'darwin')).toBe(false);
    expect(configurePlatformAuthenticator({ configureWebAuthn }, 'linux')).toBe(false);
    expect(configureWebAuthn).toHaveBeenCalledTimes(1);

    const onError = vi.fn();
    const refuses = { configureWebAuthn: () => { throw new Error('no keychain group'); } };
    expect(configurePlatformAuthenticator(refuses, 'darwin', onError)).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  const read = (path: string) => readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
  const builder = read('electron-builder.yml');
  const ymlValue = (key: string) => builder.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  const keysOf = (plist: string) => [...plist.matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]);
  const isRestricted = (k: string) => k === 'keychain-access-groups' || k === 'com.apple.application-identifier' || k.startsWith('com.apple.developer.');
  const valueOf = (plist: string, key: string) => plist.slice(plist.indexOf(`<key>${key}</key>`)).match(/<string>(.*?)<\/string>/)?.[1];

  it('is in the signed entitlements, spelled out: macOS grants the group only when the signature carries it', () => {
    const plist = read('build/entitlements.mac.plist');
    expect(plist).toContain('<key>keychain-access-groups</key>');
    // codesign expands no build variable, so a placeholder in a value here would ship a group macOS never grants.
    const group = valueOf(plist, 'keychain-access-groups');
    expect(group).toBe(WEBAUTHN_KEYCHAIN_ACCESS_GROUP);
    expect(group).not.toContain('$(');
  });

  it('keeps restricted entitlements on the main executable only, and only with a provisioning profile (#2688, #2703)', () => {
    // macOS refuses to launch a Developer ID binary carrying any of these without a profile that authorizes it, and only the main executable has one.
    const main = ymlValue('entitlements');
    const inherit = ymlValue('entitlementsInherit');
    expect(main).toBe('build/entitlements.mac.plist');
    expect(inherit).toBe('build/entitlements.mac.inherit.plist');

    const mainPlist = read(main!);
    const inheritPlist = read(inherit!);
    expect(keysOf(inheritPlist).filter(isRestricted)).toEqual([]);
    // The helpers need everything else the main executable has (they run V8).
    expect(keysOf(inheritPlist).sort()).toEqual(keysOf(mainPlist).filter((k) => !isRestricted(k)).sort());

    const restricted = keysOf(mainPlist).filter(isRestricted);
    if (!ymlValue('provisioningProfile')) {
      expect(restricted).toEqual([]);
      return;
    }
    expect(restricted.sort()).toEqual(['com.apple.application-identifier', 'com.apple.developer.team-identifier', 'keychain-access-groups']);
    expect(valueOf(mainPlist, 'com.apple.application-identifier')).toBe(`${APPLE_TEAM_ID}.${ymlValue('appId')}`);
    expect(valueOf(mainPlist, 'com.apple.developer.team-identifier')).toBe(APPLE_TEAM_ID);
  });
});
