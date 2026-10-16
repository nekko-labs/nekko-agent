import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRelay, localRelayUrl, tailnetAddress } from './local-relay.js';

const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.192.0.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;

/** A relay process that says READY (or fails) the way relay-main.ts does. */
function fakeChild(outcome: 'ready' | 'in-use' | 'silent') {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin, exitCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    (child as { exitCode: number | null }).exitCode = 0;
    child.emit('exit', 0);
  };
  child.kill = (() => (exit(), true)) as ChildProcess['kill'];
  stdin.on('finish', exit);
  setTimeout(() => {
    if (outcome === 'ready') stdout.write('NEKKO_RELAY_READY {"port":4400}\n');
    if (outcome === 'in-use') {
      stderr.write('NEKKO_RELAY_ERROR {"code":"EADDRINUSE","message":"listen EADDRINUSE"}\n');
      setTimeout(() => {
        (child as { exitCode: number | null }).exitCode = 1;
        child.emit('exit', 1);
      }, 5);
    }
  }, 5);
  return child;
}

describe('tailnetAddress', () => {
  it('picks the Tailscale address and ignores LAN, loopback and IPv6', () => {
    const ifaces = {
      lo: [nic('127.0.0.1', true)],
      en0: [nic('192.168.1.20'), { ...nic('fe80::1'), family: 'IPv6' } as NetworkInterfaceInfo],
      utun4: [nic('100.101.102.103')],
    };
    expect(tailnetAddress(ifaces)).toBe('100.101.102.103');
    expect(tailnetAddress({ en0: [nic('192.168.1.20')] })).toBeUndefined();
  });

  it('prefers the MagicDNS name in the address phones dial', () => {
    expect(localRelayUrl('mac.tail1234.ts.net', '100.101.102.103', 4400)).toBe('ws://mac.tail1234.ts.net:4400');
    expect(localRelayUrl(undefined, '100.101.102.103', 4400)).toBe('ws://100.101.102.103:4400');
  });
});

describe('LocalRelay', () => {
  const relays: LocalRelay[] = [];
  afterEach(() => relays.splice(0).forEach((r) => r.close()));

  const setup = (opts: { ip?: string; outcome?: 'ready' | 'in-use' | 'silent'; saved?: object } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'local-relay-'));
    const stateFile = join(dir, 'local-relay.json');
    if (opts.saved) writeFileSync(stateFile, JSON.stringify(opts.saved));
    let ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = { utun4: opts.ip === undefined ? [nic('100.101.102.103')] : opts.ip ? [nic(opts.ip)] : [] };
    const spawned: Array<{ host: string; port: number }> = [];
    const relay = new LocalRelay({
      stateFile,
      entry: '/bundle/relay.js',
      interfaces: () => ifaces,
      tailnetName: async () => 'mac.tail1234.ts.net',
      spawnRelay: (_entry, host, port) => {
        spawned.push({ host, port });
        return fakeChild(opts.outcome ?? 'ready');
      },
      watchMs: 20,
      startTimeoutMs: 200,
    });
    relays.push(relay);
    return { relay, stateFile, spawned, setIfaces: (next: typeof ifaces) => (ifaces = next) };
  };

  it('starts on the tailnet address only and reports the address phones use', async () => {
    const { relay, spawned, stateFile } = setup();
    expect(relay.status()).toMatchObject({ running: false, enabled: false, tailnetIp: '100.101.102.103' });
    const s = await relay.start();
    expect(spawned).toEqual([{ host: '100.101.102.103', port: 4400 }]);
    expect(s).toMatchObject({ running: true, enabled: true, url: 'ws://mac.tail1234.ts.net:4400', tailnetName: 'mac.tail1234.ts.net' });
    expect(s.error).toBeUndefined();
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: true, port: 4400 });

    const off = await relay.stop();
    expect(off).toMatchObject({ running: false, enabled: false });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: false, port: 4400 });
  });

  it('says Tailscale is off instead of binding anywhere else, and starts when it comes up', async () => {
    const { relay, spawned, setIfaces } = setup({ ip: '' });
    const s = await relay.start();
    expect(spawned).toEqual([]);
    expect(s).toMatchObject({ running: false, enabled: true });
    expect(s.error).toMatch(/Tailscale isn't connected/);

    setIfaces({ utun4: [nic('100.88.1.2')] });
    await expect.poll(() => relay.status().running, { timeout: 2000 }).toBe(true);
    expect(spawned).toEqual([{ host: '100.88.1.2', port: 4400 }]);
  });

  it('moves to the new address when the tailnet address changes', async () => {
    const { relay, spawned, setIfaces } = setup();
    await relay.start();
    setIfaces({ utun4: [nic('100.99.0.9')] });
    await expect.poll(() => spawned.length, { timeout: 2000 }).toBe(2);
    await expect.poll(() => relay.status().url, { timeout: 2000 }).toBe('ws://mac.tail1234.ts.net:4400');
    expect(spawned[1]).toEqual({ host: '100.99.0.9', port: 4400 });
  });

  it('explains a port that is already taken', async () => {
    const { relay } = setup({ outcome: 'in-use' });
    const s = await relay.start();
    expect(s.running).toBe(false);
    expect(s.error).toMatch(/Port 4400 is already in use/);
  });

  it('gives up on a relay that never says it is ready', async () => {
    const { relay } = setup({ outcome: 'silent' });
    const s = await relay.start();
    expect(s.running).toBe(false);
    expect(s.error).toMatch(/did not start in time/);
  });

  it('comes back at launch when it was switched on, and stays off otherwise', async () => {
    const on = setup({ saved: { enabled: true, port: 4411 } });
    on.relay.resume();
    await expect.poll(() => on.relay.status().running, { timeout: 2000 }).toBe(true);
    expect(on.spawned).toEqual([{ host: '100.101.102.103', port: 4411 }]);

    const off = setup({ saved: { enabled: false, port: 4400 } });
    off.relay.resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(off.spawned).toEqual([]);
  });
});
