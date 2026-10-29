import { describe, expect, it } from 'vitest';
import type { Session } from 'electron';
import { guardSession, isLocalUrl } from './connectionsGuard.js';

function fakeSession() {
  let handler: ((d: { url: string; webContentsId?: number }, cb: (r: { cancel?: boolean }) => void) => void) | null = null;
  const session = { webRequest: { onBeforeRequest: (h: typeof handler) => { handler = h; } } } as unknown as Session;
  const ask = (url: string, webContentsId?: number) => new Promise<boolean>((resolve) => handler!({ url, webContentsId }, (r) => resolve(!!r.cancel)));
  return { session, ask };
}

describe('connections guard', () => {
  it('treats loopback and non-web URLs as local', () => {
    for (const u of ['http://localhost:5173/', 'http://127.0.0.1/x', 'http://[::1]/', 'file:///a', 'devtools://x', 'about:blank']) expect(isLocalUrl(u)).toBe(true);
    for (const u of ['https://example.com/', 'wss://relay.example/', 'http://192.168.1.2/']) expect(isLocalUrl(u)).toBe(false);
  });

  it('cancels requests off this computer while the connection is off, and only for guarded pages', async () => {
    const { session, ask } = fakeSession();
    let settings: { allOff?: boolean; blocked?: string[] } | undefined = { blocked: ['browser-pane'] };
    guardSession(session, 'browser-pane', async () => settings, (id) => id === 7);
    expect(await ask('https://example.com/', 7)).toBe(true);
    expect(await ask('http://localhost:3000/', 7)).toBe(false);
    expect(await ask('https://example.com/', 8)).toBe(false);
    settings = undefined;
    // Cached for a moment: still blocked.
    expect(await ask('https://example.com/', 7)).toBe(true);
  });

  it('fails open when the settings cannot be read', async () => {
    const { session, ask } = fakeSession();
    guardSession(session, 'web-tools', () => Promise.reject(new Error('engine down')));
    expect(await ask('https://example.com/')).toBe(false);
  });
});
