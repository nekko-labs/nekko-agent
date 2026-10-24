/**
 * Where security keys and passkeys can work (SK-4, SK-5).
 *
 * The desktop app runs WebAuthn in main's loopback ceremony window, so it
 * always can. In a browser (the Local Web UI) WebAuthn runs in the page and
 * needs a secure context: `http://localhost` is one, `https` is one, a
 * Local Web UI reached as `http://<name>` on the network is not. One-time
 * codes work everywhere: they are typed, not signed.
 */

interface PageLike {
  isSecureContext?: boolean;
  location?: { hostname: string; protocol: string };
  navigator?: { credentials?: unknown };
  PublicKeyCredential?: unknown;
  nekkoChrome?: unknown;
}

/** The step-up message for a page that is not a secure context. */
export const NEEDS_HTTPS_MESSAGE =
  'Security keys and passkeys need https here. Open the Local Web UI on this computer at http://localhost, or serve it over https. One-time codes still work.';

/** True in the desktop app (its window-chrome bridge exists). */
export function isDesktopApp(page: PageLike): boolean {
  return !!page.nekkoChrome;
}

/** Why this page cannot use a security key or passkey, or null when it can. */
export function webAuthnUnavailableReason(page: PageLike): string | null {
  if (isDesktopApp(page)) return null;
  if (!page.isSecureContext) return NEEDS_HTTPS_MESSAGE;
  if (!page.PublicKeyCredential || !page.navigator?.credentials) return 'This browser can’t use security keys or passkeys. One-time codes still work.';
  return null;
}

/** The relying-party id a key registered or used from this page is bound to. */
export function pageRpId(page: PageLike): string {
  // The desktop's ceremony window is http://localhost:<port>.
  return isDesktopApp(page) ? 'localhost' : (page.location?.hostname ?? 'localhost').toLowerCase();
}

/** Whether this page's platform has a passkey authenticator Chromium can reach (none on Linux). */
export function platformPasskeyAvailable(platform: string | undefined): boolean {
  return platform !== 'linux';
}
