import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { validateBrowserInput } from '@nekko-agent/shared';
import { captureWindow } from './windowCapture.js';
import { AgentCdpTransport, isAllowedNavigation } from './agentCdpTransport.js';
import { describeLogs, runPageAction, watchPage, type PageLogEntry } from './agentBrowserActions.js';

/** A hidden browser nobody has touched for this long is closed. Each one is a
 *  full renderer that keeps painting (backgroundThrottling is off), and agents
 *  rarely send `close`, so they used to pile up until the app quit. */
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_TABS = 8;
/** Screenshot pixels above this size are not attached to the model. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Playwright's view of one chat's windows. The default drives real Playwright
 *  through the in-process CDP transport; tests substitute a fake. */
export interface BrowserDriver {
  /** Hand a fresh about:blank window to Playwright and get its Page. */
  adopt(win: BrowserWindow): Promise<Page>;
  /** Tell Playwright a window went away without it (reaper, crash). */
  forget(win: BrowserWindow): void;
  close(): Promise<void>;
}
export type BrowserDriverFactory = () => Promise<BrowserDriver>;

/** Connect playwright-core to this chat's windows only, with no debugging port. */
export const playwrightDriver: BrowserDriverFactory = async () => {
  // A plain require: the main bundle is CommonJS and playwright-core stays an
  // external dependency (see bundleExternals.test.ts). Loaded on first use only.
  const { chromium } = require('playwright-core') as typeof import('playwright-core');
  const transport = new AgentCdpTransport({
    product: `Chrome/${process.versions.chrome}`,
    userAgent: app.userAgentFallback,
    // Tabs are opened by the bridge (tab_new), never by Playwright itself.
    createTarget: async () => { throw new Error('Open tabs with the tab_new action.'); },
    closeTarget: (target) => (target as unknown as BrowserWindow).destroy(),
  });
  // A fixed artifacts folder instead of a fresh temp folder per chat that a
  // hard exit would leave behind. Downloads are denied, so it stays empty.
  const artifactsDir = join(app.getPath('userData'), 'agent-browser');
  mkdirSync(artifactsDir, { recursive: true });
  const browser = await chromium.connectOverCDP(transport, { timeout: 15_000, artifactsDir });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Agent browser context did not start.');
  return {
    async adopt(win) {
      const next = context.waitForEvent('page', { timeout: 15_000 });
      await transport.add(win);
      return next;
    },
    forget: (win) => transport.forget(win),
    // Closing the transport first detaches every debugger; Playwright then
    // sees the disconnect, so browser.close() cannot wait on a dead window.
    close: async () => { transport.close(); await browser.close().catch(() => {}); },
  };
};

interface Tab { win: BrowserWindow; page: Page; log: PageLogEntry[] }

/** First line of anything thrown. A page-side rejection (a DOMException from
 *  getDisplayMedia, say) crosses executeJavaScript as a plain object with no
 *  message, and reading `.message.split` on it crashed the request handler. */
export function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message;
  return (typeof message === 'string' && message.trim() ? message : 'Browser request failed.').split('\n')[0];
}

interface ChatBrowser { tabs: Tab[]; active: number; driver: BrowserDriver; lastUsed: number; queue: Promise<unknown> }

/** Private tool bridge. Only the backend receives its capability token, never page content. */
export async function startAgentBrowser(options: {
  driver?: BrowserDriverFactory;
  /** The engine daemon's `workspace:add` asks for the native folder picker here (`{ tool: 'pickFolder' }`). */
  pickFolder?: () => Promise<string | null>;
} = {}): Promise<{ url: string; token: string; close: () => void }> {
  const createDriver = options.driver ?? playwrightDriver;
  const token = randomBytes(32).toString('hex');
  const chats = new Map<string, ChatBrowser>();
  const starting = new Map<string, Promise<ChatBrowser>>();
  // Electron never frees a partition's session, so a fresh random partition
  // per window grew without bound. One in-memory partition per chat (salted
  // per launch) keeps chats isolated and is reused when a window reopens.
  const partitionSalt = randomBytes(16).toString('hex');
  const guardedPartitions = new Set<string>();
  const partitionFor = (sessionId: string) => `nekko-browser-${createHash('sha256').update(partitionSalt + sessionId).digest('hex').slice(0, 32)}`;

  const activeTab = (chat: ChatBrowser | undefined): Tab | undefined => chat?.tabs[chat.active];

  const closeChat = (sessionId: string) => {
    const chat = chats.get(sessionId);
    if (!chat) return;
    chats.delete(sessionId);
    // Detach before destroying: destroying a window whose debugger is still
    // attached stalls Electron's main thread.
    for (const tab of chat.tabs) chat.driver.forget(tab.win);
    void chat.driver.close().catch(() => {});
    for (const tab of chat.tabs) if (!tab.win.isDestroyed()) tab.win.destroy();
  };

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, chat] of chats) {
      if (chat.tabs.some((t) => !t.win.isDestroyed() && t.win.isVisible()) || now - chat.lastUsed < IDLE_CLOSE_MS) continue;
      closeChat(sessionId);
    }
  }, 60_000);
  reaper.unref();

  const makeWindow = (sessionId: string): BrowserWindow => {
    const win = new BrowserWindow({
      width: 1100, height: 760, title: 'Nekko Browser',
      show: false, skipTaskbar: true,
      // On Linux, focusable=false changes window-manager stacking behavior.
      ...(process.platform !== 'linux' ? { focusable: false } : {}),
      webPreferences: { partition: partitionFor(sessionId), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The agent already gets a failed navigation back from Playwright. Without
    // a listener Electron also warns about it on the app's console.
    win.webContents.on('did-fail-load', () => {});
    win.webContents.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    // The partition outlives a reaped window; listen once, not per reopen.
    const partition = partitionFor(sessionId);
    if (!guardedPartitions.has(partition)) { guardedPartitions.add(partition); win.webContents.session.on('will-download', (event) => event.preventDefault()); }
    return win;
  };

  const openTab = async (sessionId: string, chat: ChatBrowser): Promise<Tab> => {
    if (chat.tabs.length >= MAX_TABS) throw new Error(`At most ${MAX_TABS} tabs per chat; close one first.`);
    const win = makeWindow(sessionId);
    try {
      await win.loadURL('about:blank');
      const page = await chat.driver.adopt(win);
      const tab: Tab = { win, page, log: [] };
      watchPage(page, tab.log);
      win.on('closed', () => {
        chat.driver.forget(win);
        const index = chat.tabs.indexOf(tab);
        if (index < 0) return;
        chat.tabs.splice(index, 1);
        if (chat.active >= chat.tabs.length) chat.active = Math.max(0, chat.tabs.length - 1);
        if (!chat.tabs.length && chats.get(sessionId) === chat) closeChat(sessionId);
      });
      chat.tabs.push(tab);
      chat.active = chat.tabs.length - 1;
      return tab;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  };

  const ensureChat = async (sessionId: string): Promise<ChatBrowser> => {
    const existing = chats.get(sessionId);
    if (existing) return existing;
    let start = starting.get(sessionId);
    if (!start) {
      start = (async () => {
        const chat: ChatBrowser = { tabs: [], active: 0, driver: await createDriver(), lastUsed: Date.now(), queue: Promise.resolve() };
        chats.set(sessionId, chat);
        try { await openTab(sessionId, chat); }
        catch (error) { closeChat(sessionId); throw error; }
        return chat;
      })().finally(() => starting.delete(sessionId));
      starting.set(sessionId, start);
    }
    return start;
  };

  const describeTabs = (chat: ChatBrowser) => chat.tabs.map((tab, i) => `${i === chat.active ? '*' : ' '} [${i}] ${tab.page.url()}${tab.win.isDestroyed() ? '' : ` ${tab.win.webContents.getTitle()}`}`).join('\n') || 'No tabs open.';

  async function run(sessionId: string, input: Record<string, unknown>): Promise<{ output: string; image?: { data: string; mime: 'image/png'; width: number; height: number } }> {
    const action = input.action;
    if (action === 'close') { closeChat(sessionId); return { output: 'In-app browser closed.' }; }
    if (action === 'tabs' && !chats.has(sessionId)) return { output: 'No tabs open.' };
    if (action === 'logs' && !chats.has(sessionId)) return { output: describeLogs([]) };
    if (action === 'tab_close' && !chats.has(sessionId)) return { output: 'No tabs open.' };
    const fresh = !chats.has(sessionId);
    const chat = await ensureChat(sessionId);
    chat.lastUsed = Date.now();
    // One action at a time per chat, so tab bookkeeping never interleaves.
    const result = chat.queue.then(async () => {
      if (action === 'tab_new') {
        const tab = fresh ? activeTab(chat)! : await openTab(sessionId, chat);
        if (typeof input.url === 'string') return { output: await runPageAction(tab.page, { action: 'navigate', url: input.url }) };
        return { output: `Opened tab ${chat.active}.\n${describeTabs(chat)}` };
      }
      if (action === 'tab_switch' || action === 'tab_close') {
        const index = typeof input.tab === 'number' ? input.tab : chat.active;
        const tab = chat.tabs[index];
        if (!tab) throw new Error(`No tab ${index}. Use the tabs action to list them.`);
        if (action === 'tab_switch') { chat.active = index; return { output: describeTabs(chat) }; }
        if (chat.tabs.length === 1) { closeChat(sessionId); return { output: 'Closed the last tab; the in-app browser is closed.' }; }
        // Drop the tab before destroy(); the 'closed' handler then finds nothing to do.
        chat.tabs.splice(index, 1);
        if (chat.active >= chat.tabs.length || chat.active > index) chat.active = Math.max(0, chat.active - 1);
        chat.driver.forget(tab.win);
        tab.win.destroy();
        return { output: `Closed tab ${index}.\n${describeTabs(chat)}` };
      }
      const tab = activeTab(chat);
      if (!tab || tab.win.isDestroyed()) throw new Error('The browser tab closed; navigate again.');
      // Visibility is explicit and never activates the window or OS input.
      if (input.visible === true) tab.win.showInactive();
      if (input.visible === false) tab.win.hide();
      if (action === 'tabs') return { output: describeTabs(chat) };
      if (action === 'logs') { const text = describeLogs(tab.log); tab.log.length = 0; return { output: text }; }
      if (action === 'screenshot') {
        // Playwright asks the renderer for a fresh frame. capturePage on a
        // hidden window can return the last composited frame instead, which
        // went stale after a scroll in the smoke run.
        const png = await tab.page.screenshot({ type: 'png', timeout: 10_000 });
        if (png.length > MAX_SCREENSHOT_BYTES) throw new Error('The screenshot is larger than 5 MB; use the capture tool to save it to a file instead.');
        if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('The page did not produce a frame; retry after it finishes rendering.');
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        return { output: `Screenshot of tab ${chat.active} (${width}x${height}, ${tab.page.url()}). Page content only, without native window chrome.`, image: { data: png.toString('base64'), mime: 'image/png' as const, width, height } };
      }
      return { output: await runPageAction(tab.page, input) };
    });
    chat.queue = result.catch(() => {});
    return result;
  }

  let recorderUrl: string | undefined;
  const recorderPath = `/recorder-${randomBytes(24).toString('hex')}`;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Loopback is a secure context for getDisplayMedia. The random route is
    // only an empty recorder page, never a capability-bearing API endpoint.
    if (req.method === 'GET' && req.url === recorderPath && !req.headers.origin) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'none'; frame-ancestors 'none'" });
      res.end('<html><body>Window recorder</body></html>'); return;
    }
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      reply(403, { error: 'Browser bridge access denied.' }); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64_000) throw new Error('Browser request too large.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      // Not a chat's: the daemon's `workspace:add` (crates/nekkod/src/small_services.rs).
      if (input.tool === 'pickFolder') {
        if (!options.pickFolder) throw new Error('No folder picker here.');
        reply(200, { path: await options.pickFolder() }); return;
      }
      const { sessionId } = input;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error(input.tool === 'capture' ? 'Invalid capture session' : 'Invalid browser request.');
      if (input.tool === 'capture') {
        const owned = activeTab(chats.get(sessionId))?.win;
        reply(200, await captureWindow(sessionId, input, recorderUrl, owned)); return;
      }
      validateBrowserInput(input);
      if (input.action === 'navigate' && !isAllowedNavigation(input.url)) throw new Error('Only HTTP(S) pages can be opened.');
      reply(200, await run(sessionId, input));
    } catch (error) { reply(400, { error: errorLine(error) }); }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser bridge did not start.');
  recorderUrl = `http://127.0.0.1:${address.port}${recorderPath}`;
  return { url: `http://127.0.0.1:${address.port}/`, token, close: () => { clearInterval(reaper); for (const id of [...chats.keys()]) closeChat(id); server.close(); } };
}
