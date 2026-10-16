import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./relay.js', () => ({
  connectRelayAgent: () => ({ stop() {}, kickDevice() {}, connectedDevices: () => [], isOnline: () => false, lastError: () => undefined }),
}));

const { createRemoteService } = await import('./remote.js');
const { setDataDir } = await import('./paths.js');

describe('remote access transport rule (PH1)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const service = () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-remote-rule-'));
    dirs.push(dir);
    setDataDir(dir);
    return { remote: createRemoteService({} as never), file: join(dir, 'remote.json') };
  };

  it('refuses plain ws:// to the open internet, before saving anything', () => {
    const { remote, file } = service();
    expect(() => remote.enable('ws://relay.example.com')).toThrow(/not encrypted \(ws:\/\/\) and is on the open internet/);
    expect(() => remote.attach({ relayUrl: 'ws://203.0.113.9:4400', room: 'r', secret: 's' })).toThrow(/not encrypted/);
    expect(() => readFileSync(file)).toThrow();
  });

  it('accepts wss anywhere and ws on a tailnet, the LAN or loopback', () => {
    const { remote } = service();
    for (const url of ['wss://relay.example.com', 'ws://studio.tail1234.ts.net:4400', 'ws://100.101.102.103:4400', 'ws://192.168.1.20:4400', 'ws://127.0.0.1:4400']) {
      expect(remote.enable(url)).toMatchObject({ enabled: true, relayUrl: url });
    }
  });
});
