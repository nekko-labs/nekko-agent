import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SECURITY_KEY_UNTESTED_NOTE, WEBAUTHN_CANCELLED, WEBAUTHN_CEREMONY_TIMEOUT_MS, type WebAuthnCeremonyRequest, type WebAuthnCeremonyResult } from '@nekko-agent/shared';
import { CEREMONY_PAGE_CSP, ceremonyPage, runWebAuthnCeremony, validCeremonyRequest } from '../webauthnCeremony.js';

/**
 * The desktop's WebAuthn ceremony window (SK-4).
 *
 * WebAuthn needs a secure origin with a domain: the app's own page is
 * `file://`, which has neither, so `navigator.credentials` refuses there.
 * Main serves a tiny static page on `http://localhost:<port>` (a secure
 * context; the relying-party id is `localhost`), opens it in a small modal
 * window, runs the ceremony in it and hands the JSON result back. The
 * daemon verifies everything; this window only lets the key talk to the
 * browser engine. The page has no script of its own, no permissions, no
 * navigation, and a session of its own. That session is persistent, which the
 * page itself has no use for: Electron keeps the Touch ID metadata secret in
 * the prefs of the session that ran the ceremony, and an in-memory one has no
 * folder to keep them in (see the partition in main/index.ts).
 */

/** The parts of Electron the window uses, so tests can fake them. */
export interface CeremonyWindow {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): void;
  webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    on(event: 'will-navigate', listener: (e: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    session: {
      setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (ok: boolean) => void) => void): void;
    };
  };
}

/**
 * What the owner is told when this computer has no platform authenticator to
 * offer: Linux, and for now every Mac, since Touch ID stays off until a
 * provisioning profile lets the build carry its keychain access group
 * (webauthnPlatform.ts, #2703). Without this the window waits on a prompt that
 * never comes.
 */
export const NO_PLATFORM_AUTHENTICATOR = 'This computer has no built-in passkey (Touch ID or Windows Hello) to register. Use a security key instead.';

/** Asked in the ceremony window before a platform registration: does this computer actually have one? */
const PLATFORM_AUTHENTICATOR_PROBE =
  'typeof PublicKeyCredential === "function" && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : false';

export interface CeremonyDeps {
  /** A new modal window over `parent` (the window that asked). */
  openWindow(title: string): CeremonyWindow;
  /** A loopback server for the page (tests pass a fake). */
  serve?(html: string): Promise<{ port: number; close(): void }>;
  timeoutMs?: number;
}

/** Serve `html` on 127.0.0.1, any free port; every path answers the page. */
export async function servePage(html: string): Promise<{ port: number; close(): void }> {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CEREMONY_PAGE_CSP,
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

let busy = false;

/** Run one ceremony in its own window. One at a time: a second is refused while one is open. */
export async function runCeremonyWindow(request: unknown, deps: CeremonyDeps): Promise<WebAuthnCeremonyResult> {
  if (!validCeremonyRequest(request)) return { ok: false, error: 'That request to the security key was malformed.' };
  if (busy) return { ok: false, error: 'A security key prompt is already open.' };
  busy = true;
  const req: WebAuthnCeremonyRequest = { ...request, rpId: 'localhost' };
  const page = ceremonyPage(req.mode, req.mode === 'create' ? req.attachment : undefined, SECURITY_KEY_UNTESTED_NOTE);
  let server: { port: number; close(): void } | null = null;
  let win: CeremonyWindow | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    server = await (deps.serve ?? servePage)(page);
    win = deps.openWindow(req.mode === 'create' ? 'Register a security key' : 'Confirm with your security key');
    const w = win;
    w.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const closed = new Promise<WebAuthnCeremonyResult>((resolve) => w.once('closed', () => resolve({ ok: false, error: WEBAUTHN_CANCELLED, cancelled: true })));
    const timedOut = new Promise<WebAuthnCeremonyResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: 'The security key didn’t answer in time.', cancelled: true }), deps.timeoutMs ?? WEBAUTHN_CEREMONY_TIMEOUT_MS);
    });
    await w.loadURL(`http://localhost:${server.port}/${req.mode}`);
    // The page is only a stage: the ceremony is this one function, run in it.
    const code = `(${runWebAuthnCeremony.toString()})(${JSON.stringify(req)}, navigator.credentials)`;
    const ran = (async (): Promise<WebAuthnCeremonyResult> => {
      // A platform registration with no platform authenticator never prompts, so
      // say so instead of waiting out the timeout. Asked before the window is
      // shown, so an answer of no is a message rather than a window that flashes;
      // the first ask of a session makes a Secure Enclave key pair and takes a
      // few hundred milliseconds, which is a pause before the window rather than
      // a pause in it. The Add passkey button is disabled meanwhile.
      if (req.mode === 'create' && req.attachment === 'platform') {
        const available = await w.webContents.executeJavaScript(PLATFORM_AUTHENTICATOR_PROBE).catch(() => false);
        if (available !== true) return { ok: false, error: NO_PLATFORM_AUTHENTICATOR };
      }
      w.show();
      w.focus();
      return await w.webContents.executeJavaScript(code, true).then(
        (r) => (r && typeof r === 'object' && 'ok' in r ? (r as WebAuthnCeremonyResult) : { ok: false as const, error: 'The security key prompt gave no answer.' }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
      );
    })();
    return await Promise.race([ran, closed, timedOut]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.close();
    server?.close();
    busy = false;
  }
}
