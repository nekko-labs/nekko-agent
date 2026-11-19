import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A page being captured reaches only its own preview server, never another loopback service. */
const electron = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    beforeRequest: null as null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
    duringLoad: [] as Array<{ url: string; cancel: boolean }>,
    probe: [] as string[],
    userData: '',
  };
  const ask = (url: string) => {
    let cancel = true;
    state.beforeRequest?.({ url }, (r) => { cancel = r.cancel; });
    return cancel;
  };
  class BrowserWindow {
    webContents = { setWindowOpenHandler: () => {}, on: () => {} };
    destroyed = false;
    async loadURL() { for (const url of state.probe) state.duringLoad.push({ url, cancel: ask(url) }); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async capturePage() { return { isEmpty: () => true }; }
  }
  return {
    state, ask,
    module: {
      app: { getPath: () => state.userData },
      ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn) },
      session: { fromPartition: () => ({ setPermissionRequestHandler: () => {}, webRequest: { onBeforeRequest: (_f: unknown, fn: typeof state.beforeRequest) => { state.beforeRequest = fn; } } }) },
      BrowserWindow,
    },
  };
});
vi.mock('electron', () => electron.module);

describe('the thumbnail capture window', () => {
  it('lets a page reach only the preview origin being captured', async () => {
    vi.useFakeTimers();
    electron.state.userData = mkdtempSync(join(tmpdir(), 'thumbs-'));
    const { registerLibraryThumbnails, originOf } = await import('./libraryThumbnails.js');
    const { LIBRARY_THUMBNAIL_CHANNELS } = await import('@nekko-agent/shared');
    expect(originOf('http://127.0.0.1:5123/p/a.html')).toBe('http://127.0.0.1:5123');
    expect(originOf('not a url')).toBe('');

    const sender = { mainFrame: {} };
    registerLibraryThumbnails(() => true, (url) => url.startsWith('http://127.0.0.1:5123/'));
    const capture = electron.state.handlers.get(LIBRARY_THUMBNAIL_CHANNELS.capture)!;
    electron.state.probe = ['http://127.0.0.1:5123/p/style.css', 'http://127.0.0.1:7777/api/sessions', 'https://example.com/x.js'];

    // Not issued by the preview server: refused before any window opens.
    expect(await capture({ sender, senderFrame: sender.mainFrame }, 'http://127.0.0.1:7777/')).toBeNull();
    expect(electron.state.duringLoad).toEqual([]);

    const done = capture({ sender, senderFrame: sender.mainFrame }, 'http://127.0.0.1:5123/p/a.html') as Promise<unknown>;
    await vi.runAllTimersAsync();
    await done;
    expect(electron.state.duringLoad).toEqual([
      { url: 'http://127.0.0.1:5123/p/style.css', cancel: false },
      { url: 'http://127.0.0.1:7777/api/sessions', cancel: true },
      { url: 'https://example.com/x.js', cancel: true },
    ]);
    // Once the capture ends, its origin is closed again.
    expect(electron.ask('http://127.0.0.1:5123/p/style.css')).toBe(true);
    vi.useRealTimers();
  });
});
