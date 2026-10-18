import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { AgentNativeClient } from './agentNativeClient.js';
import { AgentNativePage } from './agentNativePage.js';
import { startNativeRelay } from './agentNativeRelay.js';

export const nativeDriver = () => createNativeDriver();

/** Tests pass their staged binary explicitly; production never reads a binary override from env. */
export async function createNativeDriver(testBinary?: string) {
  const owned = new Map<BrowserWindow, { client: AgentNativeClient; relay: Awaited<ReturnType<typeof startNativeRelay>> }>();
  return {
    async adopt(win: BrowserWindow): Promise<AgentNativePage> {
      const binary = app.isPackaged
        ? join(process.resourcesPath, 'agent-browser', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser')
        : join(app.getAppPath(), 'resources/agent-browser', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser');
      const relay = await startNativeRelay({ product: `Chrome/${process.versions.chrome}`, userAgent: app.userAgentFallback, createTarget: async () => { throw new Error('Use tab_new.'); }, closeTarget: () => { throw new Error('Use tab_close.'); } }, win);
      const client = new AgentNativeClient(testBinary ?? binary);
      owned.set(win, { client, relay });
      try {
        await client.command('launch', { cdpUrl: relay.endpoint });
        return new AgentNativePage(client, win);
      } catch (error) { owned.delete(win); client.close(); relay.close(); throw error; }
    },
    forget(win: BrowserWindow): void {
      const entry = owned.get(win); if (!entry) return;
      owned.delete(win); entry.relay.close(); entry.client.close();
    },
    async close(): Promise<void> { for (const [win, entry] of owned) { owned.delete(win); entry.relay.close(); entry.client.close(); } },
  };
}
