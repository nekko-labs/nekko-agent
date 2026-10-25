import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SECURITY_KEY_UNTESTED_NOTE, WEBAUTHN_CEREMONY_TIMEOUT_MS, type WebAuthnCeremonyRequest, type WebAuthnCeremonyResult } from '@nekko-agent/shared';
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
 * navigation, and a session of its own that keeps nothing.
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
    const closed = new Promise<WebAuthnCeremonyResult>((resolve) => w.once('closed', () => resolve({ ok: false, error: 'Cancelled.', cancelled: true })));
    const timedOut = new Promise<WebAuthnCeremonyResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: 'The security key didn’t answer in time.', cancelled: true }), deps.timeoutMs ?? WEBAUTHN_CEREMONY_TIMEOUT_MS);
    });
    await w.loadURL(`http://localhost:${server.port}/${req.mode}`);
    w.show();
    w.focus();
    // The page is only a stage: the ceremony is this one function, run in it.
    const code = `(${runWebAuthnCeremony.toString()})(${JSON.stringify(req)}, navigator.credentials)`;
    const ran = w.webContents.executeJavaScript(code, true).then(
      (r) => (r && typeof r === 'object' && 'ok' in r ? (r as WebAuthnCeremonyResult) : { ok: false as const, error: 'The security key prompt gave no answer.' }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    );
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
