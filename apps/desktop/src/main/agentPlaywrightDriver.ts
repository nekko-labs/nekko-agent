import { app, type BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserDriverFactory } from './agentBrowser.js';
import { AgentCdpTransport } from './agentCdpTransport.js';
import { untimed } from './agentBrowserTiming.js';
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
    async adopt(win, mark = untimed) {
      return mark('attach', async () => {
        const next = context.waitForEvent('page', { timeout: 15_000 });
        await transport.add(win);
        return next;
      });
    },
    forget: (win) => transport.forget(win),
    // Closing the transport first detaches every debugger; Playwright then
    // sees the disconnect, so browser.close() cannot wait on a dead window.
    close: async () => { transport.close(); await browser.close().catch(() => {}); },
  };
};
