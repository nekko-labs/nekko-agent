import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { startNativeRelay } from './agentNativeRelay.js';

class Debugger extends EventEmitter {
  attached = false;
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  isAttached() { return this.attached; }
  async sendCommand(method: string) { return method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'owned', type: 'page' } } : {}; }
}
const connect = (url: string, origin?: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url, origin ? { origin } : {}); ws.once('open', () => resolve(ws)); ws.once('error', reject);
});
const request = (ws: WebSocket, id: number, method: string, params = {}) => new Promise<any>((resolve) => {
  const listener = (data: WebSocket.RawData) => { const frame = JSON.parse(data.toString()); if (frame.id === id) { ws.off('message', listener); resolve(frame); } };
  ws.on('message', listener); ws.send(JSON.stringify({ id, method, params }));
});
describe('native owned-page relay', () => {
  it('rejects missing/wrong capabilities and renderer Origin; allows one owned client only', async () => {
    const dbg = new Debugger();
    const relay = await startNativeRelay({ product: 'Chrome/test', userAgent: 'test', createTarget: async () => { throw new Error('no'); }, closeTarget: () => {} }, { webContents: { debugger: dbg, isDestroyed: () => false } });
    let ws: WebSocket | undefined;
    try {
      const missing = new URL(relay.endpoint); missing.search = '';
      await expect(connect(missing.href)).rejects.toThrow('403');
      const wrong = new URL(relay.endpoint); wrong.searchParams.set('capability', '0'.repeat(64));
      await expect(connect(wrong.href)).rejects.toThrow('403');
      await expect(connect(relay.endpoint, 'http://localhost')).rejects.toThrow('403');
      ws = await connect(relay.endpoint);
      await expect(connect(relay.endpoint)).rejects.toThrow('403');
      expect((await request(ws, 1, 'Target.getTargets')).result.targetInfos.map((t: any) => t.targetId)).toEqual(['owned']);
      expect((await request(ws, 2, 'Target.attachToTarget', { targetId: 'ui', flatten: true })).error).toBeTruthy();
      expect((await request(ws, 3, 'Target.attachToTarget', { targetId: 'owned', flatten: true })).result.sessionId).toBe('nekko-page-1');
      expect((await request(ws, 4, 'Target.attachToBrowserTarget')).error).toBeTruthy();
      expect((await request(ws, 5, 'Browser.grantPermissions')).error).toBeTruthy();
    } finally { ws?.terminate(); relay.close(); }
    expect(dbg.attached).toBe(false);
  });
});
