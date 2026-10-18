import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const windows: any[] = [];
  class Window {
    static getAllWindows() { return windows; }
    opts: any;
    destroyed = false;
    handlers = new Map<string, (...args: any[]) => void>();
    webContents = {
      setWindowOpenHandler: vi.fn(), on: vi.fn(), getTitle: () => 'Example',
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
    };
    constructor(opts: any) { this.opts = opts; windows.push(this); }
    on(name: string, cb: (...args: any[]) => void) { this.handlers.set(name, cb); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.handlers.get('closed')?.(); }
    show = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    loadURL = vi.fn(async () => {});
  }
  return { Window, windows };
});
vi.mock('electron', () => ({ BrowserWindow: fake.Window, app: { userAgentFallback: 'test', getPath: () => '' } }));
import { errorLine, startAgentBrowser, type BrowserDriver } from './agentBrowser.js';

afterEach(() => { fake.windows.length = 0; });

// The 24 bytes of a PNG that matter here: signature, IHDR length, IHDR, 1100x760.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0x04, 0x4c, 0, 0, 0x02, 0xf8])]);

function fakeDriver() {
  const pages: any[] = [];
  const driver: BrowserDriver & { adopted: any[]; closed: boolean; forgotten: any[] } = {
    adopted: [], closed: false, forgotten: [],
    async adopt(win: any) {
      this.adopted.push(win);
      let url = 'about:blank';
      const page = {
        goto: vi.fn(async (next: string) => { url = next; return null; }),
        url: () => url,
        title: vi.fn(async () => 'Example'),
        evaluate: vi.fn(async () => 'Body'),
        locator: vi.fn(() => ({ first: () => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) }) })),
        on: vi.fn(),
        screenshot: vi.fn(async () => PNG),
      };
      pages.push(page);
      return page as any;
    },
    forget(win: any) { this.forgotten.push(win); },
    async close() { this.closed = true; },
  };
  return { driver, pages };
}

describe('private Electron browser bridge', () => {
  it('rejects unauthenticated and page-origin requests, isolates content, and closes sessions', async () => {
    const { driver, pages } = fakeDriver();
    const bridge = await startAgentBrowser({ driver: async () => driver });
    const body = JSON.stringify({ sessionId: 'chat', action: 'navigate', url: 'https://example.com' });
    const post = (headers: Record<string, string>, payload = body) => fetch(bridge.url, { method: 'POST', headers, body: payload });
    try {
      expect((await post({})).status).toBe(403);
      expect((await post({ Authorization: `Bearer ${bridge.token}`, Origin: 'https://evil.test' })).status).toBe(403);
      expect(fake.windows).toHaveLength(0);
      const headers = { Authorization: `Bearer ${bridge.token}` };
      expect((await post(headers, JSON.stringify({ sessionId: 'chat', action: 'navigate', url: 'file:///secret' }))).status).toBe(400);
      expect((await post(headers, JSON.stringify({ sessionId: 'chat', action: 'launch_missiles' }))).status).toBe(400);
      expect(fake.windows).toHaveLength(0);
      const result = await post(headers);
      expect(await result.json()).toEqual({ output: 'Example\nBody' });
      expect(pages[0].goto).toHaveBeenCalledWith('https://example.com', expect.anything());
      const win = fake.windows[0];
      expect(driver.adopted).toEqual([win]);
      expect(win.loadURL).toHaveBeenCalledWith('about:blank'); // committed before Playwright adopts it
      expect(win.opts).toMatchObject({ show: false, skipTaskbar: true });
      if (process.platform !== 'linux') expect(win.opts.focusable).toBe(false);
      expect(win.show).not.toHaveBeenCalled();
      expect(win.showInactive).not.toHaveBeenCalled();
      await post(headers, JSON.stringify({ sessionId: 'chat', action: 'inspect', visible: true }));
      expect(win.showInactive).toHaveBeenCalledOnce();
      await post(headers, JSON.stringify({ sessionId: 'chat', action: 'inspect', visible: false }));
      expect(win.hide).toHaveBeenCalledOnce();
      expect(win.show).not.toHaveBeenCalled();
      expect(win.opts.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true });
      expect(win.opts.webPreferences.partition).not.toContain('persist:');
      expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
      const callback = vi.fn();
      win.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', callback);
      expect(callback).toHaveBeenCalledWith(false);
      const close = await post(headers, JSON.stringify({ sessionId: 'chat', action: 'close' }));
      expect(await close.json()).toEqual({ output: 'In-app browser closed.' });
      expect(driver.forgotten).toContain(win); // debugger detached before the window is destroyed
      expect(driver.closed).toBe(true);
      expect(win.destroyed).toBe(true);
    } finally { bridge.close(); }
  });

  it('manages tabs per chat and returns screenshots as image data, not text', async () => {
    const drivers: ReturnType<typeof fakeDriver>[] = [];
    const bridge = await startAgentBrowser({ driver: async () => { const d = fakeDriver(); drivers.push(d); return d.driver; } });
    const post = async (input: object) => {
      const response = await fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    try {
      expect((await post({ sessionId: 'a', action: 'tabs' })).body.output).toBe('No tabs open.');
      expect(fake.windows).toHaveLength(0); // listing never opens a window
      await post({ sessionId: 'a', action: 'navigate', url: 'https://one.test/' });
      await post({ sessionId: 'a', action: 'tab_new', url: 'https://two.test/' });
      const tabs = (await post({ sessionId: 'a', action: 'tabs' })).body.output;
      expect(tabs).toContain('  [0] https://one.test/');
      expect(tabs).toContain('* [1] https://two.test/');
      expect((await post({ sessionId: 'a', action: 'tab_switch', tab: 0 })).body.output).toContain('* [0] https://one.test/');
      expect((await post({ sessionId: 'a', action: 'tab_switch', tab: 7 })).status).toBe(400);
      // Another chat gets its own driver and windows.
      await post({ sessionId: 'b', action: 'inspect' });
      expect(drivers).toHaveLength(2);
      expect(fake.windows[2].opts.webPreferences.partition).not.toBe(fake.windows[0].opts.webPreferences.partition);
      const shot = await post({ sessionId: 'a', action: 'screenshot' });
      expect(shot.body.image).toEqual({ data: PNG.toString('base64'), mime: 'image/png', width: 1100, height: 760 });
      expect(shot.body.output).not.toContain(shot.body.image.data);
      expect(drivers[0].pages[0].screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' })); // the active tab, a fresh frame
      expect((await post({ sessionId: 'a', action: 'tab_close', tab: 1 })).body.output).toContain('Closed tab 1');
      expect(fake.windows[1].destroyed).toBe(true);
      expect(drivers[0].driver.forgotten).toContain(fake.windows[1]);
      expect((await post({ sessionId: 'a', action: 'tab_close' })).body.output).toContain('the in-app browser is closed');
      expect(drivers[0].driver.closed).toBe(true);
      expect(fake.windows[2].destroyed).toBe(false);
    } finally { bridge.close(); }
    expect(fake.windows.every((w) => w.destroyed)).toBe(true);
  });

  it('answers the daemon folder picker request through the same token, opening no browser', async () => {
    const pickFolder = vi.fn(async () => 'C:\\picked');
    const bridge = await startAgentBrowser({ driver: async () => fakeDriver().driver, pickFolder });
    const post = (headers: Record<string, string>) => fetch(bridge.url, { method: 'POST', headers, body: JSON.stringify({ tool: 'pickFolder' }) });
    try {
      expect((await post({})).status).toBe(403);
      expect(pickFolder).not.toHaveBeenCalled();
      const ok = await post({ Authorization: `Bearer ${bridge.token}` });
      expect(await ok.json()).toEqual({ path: 'C:\\picked' });
      pickFolder.mockResolvedValueOnce(null as never);
      expect(await (await post({ Authorization: `Bearer ${bridge.token}` })).json()).toEqual({ path: null });
      expect(fake.windows).toHaveLength(0);
    } finally { bridge.close(); }
    const bare = await startAgentBrowser({ driver: async () => fakeDriver().driver });
    try {
      const refused = await fetch(bare.url, { method: 'POST', headers: { Authorization: `Bearer ${bare.token}` }, body: JSON.stringify({ tool: 'pickFolder' }) });
      expect(refused.status).toBe(400);
    } finally { bare.close(); }
  });

  it('answers what the daemon asks of the window shell, behind the token', async () => {
    const shell = { nativeWindow: vi.fn(() => '1234'), dialog: vi.fn(async () => ['C:\\a.txt']), quitForUpdate: vi.fn() };
    const bridge = await startAgentBrowser({ driver: async () => fakeDriver().driver, shell });
    const post = async (body: unknown, auth = true) => {
      const res = await fetch(bridge.url, { method: 'POST', headers: auth ? { Authorization: `Bearer ${bridge.token}` } : {}, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      expect((await post({ tool: 'nativeWindow' }, false)).status).toBe(403);
      expect((await post({ tool: 'nativeWindow' })).body).toEqual({ handle: '1234' });
      expect((await post({ tool: 'dialog', kind: 'openFiles', options: { multiple: true } })).body).toEqual({ result: ['C:\\a.txt'] });
      expect(shell.dialog).toHaveBeenCalledWith('openFiles', { multiple: true });
      expect((await post({ tool: 'dialog', kind: 'exec' })).status).toBe(400);
      expect((await post({ tool: 'quitForUpdate' })).body).toEqual({ ok: true });
      expect(shell.quitForUpdate).toHaveBeenCalledOnce();
      expect(fake.windows).toHaveLength(0);
    } finally { bridge.close(); }
  });
});

describe('errorLine', () => {
  it('reports a message-less page rejection instead of crashing on it', () => {
    expect(errorLine({})).toBe('Browser request failed.');
    expect(errorLine(undefined)).toBe('Browser request failed.');
    expect(errorLine({ message: 'denied\nstack' })).toBe('denied');
    expect(errorLine(new Error('first\nsecond'))).toBe('first');
    expect(errorLine('plain')).toBe('plain');
  });
});
