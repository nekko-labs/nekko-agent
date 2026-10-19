import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRelay, localRelayUrl, readyLine, relayLanAddresses, tailnetAddress } from './local-relay.js';

const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.192.0.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;

/** A relay process that says READY (or fails) the way relay-main.ts does. */
function fakeChild(outcome: 'ready' | 'in-use' | 'silent', lan: string[] = []) {
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
    // The real relay binds what it can; this one binds all but 10.9.9.9.
    if (outcome === 'ready') stdout.write(`NEKKO_RELAY_READY ${JSON.stringify({ port: 4400, lan: lan.filter((a) => a !== '10.9.9.9') })}\n`);
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
    const spawned: Array<{ host: string; port: number; lan?: string[] }> = [];
    const relay = new LocalRelay({
      stateFile,
      entry: '/bundle/relay.js',
      interfaces: () => ifaces,
      tailnetName: async () => 'mac.tail1234.ts.net',
      spawnRelay: (_entry, host, port, lan) => {
        spawned.push({ host, port, ...(lan.length ? { lan } : {}) });
        return fakeChild(opts.outcome ?? 'ready', lan);
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

  it('learns the MagicDNS name before it starts, so the default address is the name (TS-1)', async () => {
    const { relay, spawned } = setup();
    expect(relay.status().url).toBe('ws://100.101.102.103:4400');
    await expect.poll(() => relay.status().url, { timeout: 2000 }).toBe('ws://mac.tail1234.ts.net:4400');
    expect(relay.status()).toMatchObject({ running: false, enabled: false, tailnetName: 'mac.tail1234.ts.net' });
    expect(spawned).toEqual([]);
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

  describe('on the LAN too (IO-20)', () => {
    const home = () => ({
      utun4: [nic('100.101.102.103')],
      en0: [nic('192.168.1.20'), nic('169.254.7.7'), nic('8.8.4.4')],
      en1: [nic('10.9.9.9'), nic('172.16.4.2')],
      lo: [nic('127.0.0.1', true)],
    });

    it('listens on the RFC 1918 addresses next to the tailnet, by default, and reports the ones it bound', async () => {
      const { relay, spawned, setIfaces, stateFile } = setup();
      setIfaces(home());
      const s = await relay.start();
      expect(spawned).toEqual([{ host: '100.101.102.103', port: 4400, lan: ['192.168.1.20', '10.9.9.9', '172.16.4.2'] }]);
      // 10.9.9.9 failed to bind in the relay: it is not offered to phones.
      expect(s).toMatchObject({ running: true, lan: true, lanUrls: ['ws://192.168.1.20:4400', 'ws://172.16.4.2:4400'] });
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: true, port: 4400 });
    });

    it('has a switch: off restarts on the tailnet only and is remembered', async () => {
      const { relay, spawned, setIfaces, stateFile } = setup();
      setIfaces(home());
      await relay.start();
      const off = await relay.setLan(false);
      expect(spawned.at(-1)).toEqual({ host: '100.101.102.103', port: 4400 });
      expect(off).toMatchObject({ running: true, lan: false, lanUrls: [] });
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: true, port: 4400, lan: false });

      const again = setup({ saved: { enabled: true, port: 4400, lan: false } });
      again.setIfaces(home());
      again.relay.resume();
      await expect.poll(() => again.relay.status().running, { timeout: 2000 }).toBe(true);
      expect(again.spawned).toEqual([{ host: '100.101.102.103', port: 4400 }]);

      const on = await relay.setLan(true);
      expect(on.lanUrls).toEqual(['ws://192.168.1.20:4400', 'ws://172.16.4.2:4400']);
    });

    it('moves when the LAN addresses change, and only then', async () => {
      const { relay, spawned, setIfaces } = setup();
      setIfaces(home());
      await relay.start();
      await new Promise((r) => setTimeout(r, 60));
      expect(spawned).toHaveLength(1);
      setIfaces({ utun4: [nic('100.101.102.103')], en0: [nic('192.168.7.3')] });
      await expect.poll(() => relay.status().lanUrls, { timeout: 2000 }).toEqual(['ws://192.168.7.3:4400']);
      expect(spawned.at(-1)).toEqual({ host: '100.101.102.103', port: 4400, lan: ['192.168.7.3'] });
    });

    it('needs Tailscale still: no tailnet, no relay, whatever the LAN', async () => {
      const { relay, spawned, setIfaces } = setup({ ip: '' });
      setIfaces({ en0: [nic('192.168.1.20')] });
      const s = await relay.start();
      expect(spawned).toEqual([]);
      expect(s).toMatchObject({ running: false, lanUrls: [] });
    });
  });
});

describe('relayLanAddresses / readyLine', () => {
  it('keeps RFC 1918 only, in order, once each', () => {
    expect(
      relayLanAddresses({
        a: [nic('172.15.0.1'), nic('172.16.0.1'), nic('172.31.255.1'), nic('172.32.0.1')],
        b: [nic('10.0.0.1'), nic('10.0.0.1'), nic('192.168.0.9'), nic('192.169.0.9'), nic('100.64.0.1'), nic('10.0.0.2', true)],
        c: [{ ...nic('fd00::1'), family: 'IPv6' } as NetworkInterfaceInfo],
      }),
    ).toEqual(['172.16.0.1', '172.31.255.1', '10.0.0.1', '192.168.0.9']);
  });

  it("reads what the relay bound, and an old relay's line as no LAN", () => {
    expect(readyLine('NEKKO_RELAY_READY {"port":4400,"lan":["192.168.1.20"]}\n')).toEqual({ port: 4400, lan: ['192.168.1.20'] });
    expect(readyLine('NEKKO_RELAY_READY {"port":4400}\n')).toEqual({ port: 4400, lan: [] });
    expect(readyLine('starting…')).toBeUndefined();
  });
});
