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

  it('is in the signed entitlements, spelled out: macOS grants the group only when the signature carries it', () => {
    const plist = readFileSync(join(import.meta.dirname, '../../build/entitlements.mac.plist'), 'utf8');
    expect(plist).toContain('<key>keychain-access-groups</key>');
    expect(plist).toContain(`<string>${WEBAUTHN_KEYCHAIN_ACCESS_GROUP}</string>`);
    // codesign expands no build variable, so a placeholder in a value here would ship a group macOS never grants.
    const group = plist.slice(plist.indexOf('<key>keychain-access-groups</key>')).match(/<string>(.*?)<\/string>/)?.[1];
    expect(group).toBe(WEBAUTHN_KEYCHAIN_ACCESS_GROUP);
    expect(group).not.toContain('$(');
  });
});
