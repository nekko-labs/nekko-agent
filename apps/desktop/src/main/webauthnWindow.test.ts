import { describe, expect, it, vi } from 'vitest';
import type { WebAuthnCeremonyRequest } from '@nekko-agent/shared';
import { runCeremonyWindow, servePage, type CeremonyWindow } from './webauthnWindow.js';

const get: WebAuthnCeremonyRequest = { mode: 'get', challenge: 'BwcH', allowCredentials: ['AQ'], timeoutMs: 120_000 };

function fakeWindow(run: (code: string, userGesture?: boolean) => Promise<unknown>) {
  const listeners: Record<string, () => void> = {};
  const w = {
    loadURL: vi.fn(async () => {}),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => listeners.closed?.()),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((e: string, l: () => void) => { listeners[e] = l; }),
    webContents: {
      executeJavaScript: vi.fn(run),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn() },
    },
    userClose: () => listeners.closed?.(),
  };
  return w;
}

const serve = vi.fn(async () => ({ port: 4242, close: vi.fn() }));

describe('the desktop ceremony window', () => {
  it('runs the ceremony on a localhost page, bound to localhost, then closes', async () => {
    const answer = { ok: true, mode: 'get', rpId: 'localhost', credentialId: 'AQ', authenticatorData: 'Ag', clientDataJSON: 'Aw', signature: 'BA' };
    const w = fakeWindow(async () => answer);
    const r = await runCeremonyWindow({ ...get, rpId: 'evil.example' }, { openWindow: () => w as unknown as CeremonyWindow, serve });
    expect(r).toEqual(answer);
    expect(w.loadURL).toHaveBeenCalledWith('http://localhost:4242/get');
    const code = w.webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(code).toContain('"rpId":"localhost"');
    expect(code).not.toContain('evil.example');
    expect(w.webContents.executeJavaScript.mock.calls[0][1]).toBe(true);
    expect(w.close).toHaveBeenCalled();
    // No permission is ever granted to the page.
    const deny = vi.fn();
    w.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', deny);
    expect(deny).toHaveBeenCalledWith(false);
  });

  it('cancels when the owner closes the window, and refuses a malformed request', async () => {
    let w!: ReturnType<typeof fakeWindow>;
    w = fakeWindow(() => {
      setTimeout(() => w.userClose(), 0);
      return new Promise(() => {});
    });
    expect(await runCeremonyWindow(get, { openWindow: () => w as unknown as CeremonyWindow, serve })).toMatchObject({ ok: false, cancelled: true });
    expect(await runCeremonyWindow({ mode: 'get' }, { openWindow: () => { throw new Error('never'); }, serve })).toMatchObject({ ok: false });
  });

  it('gives up when the key never answers', async () => {
    const w = fakeWindow(() => new Promise(() => {}));
    expect(await runCeremonyWindow(get, { openWindow: () => w as unknown as CeremonyWindow, serve, timeoutMs: 5 })).toMatchObject({ ok: false, cancelled: true });
  });

  it('serves only the page, on loopback, with a strict CSP', async () => {
    const s = await servePage('<p>hi</p>');
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/get`);
      expect(await res.text()).toBe('<p>hi</p>');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect((await fetch(`http://127.0.0.1:${s.port}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      s.close();
    }
  });
});
