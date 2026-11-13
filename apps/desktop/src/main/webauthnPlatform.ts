/**
 * The macOS platform authenticator for the ceremony window (SK-4).
 *
 * Electron does not service platform-authenticator requests until an app asks
 * for one: until `app.configureWebAuthn` is called,
 * `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`
 * answers false and a `create()` with `authenticatorAttachment: 'platform'`
 * is never offered to anything, so the ceremony window sat there with no
 * Touch ID prompt until it timed out.
 *
 * Of the two authenticators Electron can turn on, only Touch ID fits this
 * product. `platformPasskeys` goes through `ASAuthorizationController`, which
 * needs an associated domain and its `apple-app-site-association` file and has
 * no `localhost` escape hatch; the computer is the relying party and the
 * ceremony runs on `http://localhost` (decision 0018), so there is no domain to
 * associate. Touch ID keeps the credential in this Mac's Secure Enclave, which
 * is what a per-computer second factor wants anyway.
 *
 * The credential lives in a keychain access group, so the group has to be in
 * the signed `keychain-access-groups` entitlement and has to carry the team
 * id as its prefix. An ad-hoc or self-signed build (a local `npm run dist`
 * without `CSC_LINK`, see docs/signing.md) is not granted the group, so Touch
 * ID stays unavailable there; the ceremony window says so rather than hanging.
 *
 * Not called at startup for now. On a Developer ID build that entitlement is
 * restricted: macOS refuses to launch the app unless an embedded provisioning
 * profile authorizes it, and 0.10.1000 shipped without one (#2688). The
 * entitlement is out of build/entitlements.mac.plist until #2703 embeds the
 * profile and turns this back on.
 */

/** Nekko Labs' Apple team id, the prefix macOS requires on a keychain access group (the `APPLE_TEAM_ID` repository variable). */
export const APPLE_TEAM_ID = '3HM5598S99';

/** Where Touch ID credentials are kept. Must match `keychain-access-groups` in build/entitlements.mac.plist exactly: codesign does not expand `$(AppIdentifierPrefix)`, only Xcode does. */
export const WEBAUTHN_KEYCHAIN_ACCESS_GROUP = `${APPLE_TEAM_ID}.dev.nekkolabs.nekkoagent.webauthn`;

/**
 * The reason line in the Touch ID sheet: macOS renders it as
 * `"Nekko Agent" is trying to <reason>`. One phrase covers registering and
 * answering, since the setting is for the app and not for one ceremony, and it
 * leaves out the `$1` relying-party placeholder, which would read "localhost".
 */
export const WEBAUTHN_PROMPT_REASON = 'confirm it is you';

/** The `app.configureWebAuthn` options for a platform, or null where there is nothing to turn on. */
export function platformAuthenticatorOptions(platform: NodeJS.Platform): { touchID: { keychainAccessGroup: string; promptReason: string } } | null {
  // Windows Hello needs no configuration, and Chromium has no platform authenticator on Linux.
  if (platform !== 'darwin') return null;
  return { touchID: { keychainAccessGroup: WEBAUTHN_KEYCHAIN_ACCESS_GROUP, promptReason: WEBAUTHN_PROMPT_REASON } };
}

/** The part of Electron's `app` this uses, so tests can fake it. */
export interface WebAuthnConfigurable {
  configureWebAuthn?(options: { touchID: { keychainAccessGroup: string; promptReason: string } }): void;
}

/**
 * Turn the platform authenticator on, once, at startup. Never throws: a Mac
 * that refuses the keychain group still runs the app, and the ceremony window
 * is the one that tells the owner a passkey is not available here.
 */
export function configurePlatformAuthenticator(app: WebAuthnConfigurable, platform: NodeJS.Platform, onError?: (e: unknown) => void): boolean {
  const options = platformAuthenticatorOptions(platform);
  if (!options || !app.configureWebAuthn) return false;
  try {
    app.configureWebAuthn(options);
    return true;
  } catch (e) {
    onError?.(e);
    return false;
  }
}
