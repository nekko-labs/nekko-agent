import { mkdtempSync, readFileSync } from 'node:fs';
import type { RemoteInfo } from 'node:dgram';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVICE_TYPE,
  answersFor,
  decodePacket,
  encodePacket,
  hostLabel,
  lanAddresses,
  NetworkVisibility,
  recordsFor,
  serviceLabel,
  txtRecord,
  type Advertisement,
  type MdnsSocket,
} from './network-visibility.js';

const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;

const ad: Advertisement = { name: 'Studio', host: 'studio', addresses: ['192.168.1.20'], port: 0 };
const PTR = 12;
const SRV = 33;
const TXT = 16;
const A = 1;

describe('mDNS wire format', () => {
  it('round-trips every record we publish', () => {
    const answers = recordsFor({ ...ad, relayUrl: 'ws://studio.tail1234.ts.net:4400', port: 4400 });
    const back = decodePacket(encodePacket({ response: true, answers }));
    expect(back?.response).toBe(true);
    expect(back?.answers).toEqual(answers.map((r) => ({ ...r, unique: !!r.unique })));
  });

  it('reads compressed names in a query, the way phones send them', () => {
    // "_nekko-agent._tcp.local" PTR, then "Studio" + pointer to offset 12.
    const head = Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
    const q1 = Buffer.concat([
      Buffer.from([12]), Buffer.from('_nekko-agent'), Buffer.from([4]), Buffer.from('_tcp'), Buffer.from([5]), Buffer.from('local'), Buffer.from([0]),
      Buffer.from([0, PTR, 0x80, 1]),
    ]);
    const q2 = Buffer.concat([Buffer.from([6]), Buffer.from('Studio'), Buffer.from([0xc0, 12]), Buffer.from([0, SRV, 0, 1])]);
    const p = decodePacket(Buffer.concat([head, q1, q2]));
    expect(p?.questions).toEqual([
      { name: SERVICE_TYPE, type: PTR, unicast: true },
      { name: `Studio.${SERVICE_TYPE}`, type: SRV, unicast: false },
    ]);
  });

  it('refuses malformed packets instead of throwing', () => {
    expect(decodePacket(Buffer.from([1, 2, 3]))).toBeUndefined();
    // One question whose name is a pointer to itself.
    expect(decodePacket(Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]))).toBeUndefined();
    // A label longer than the packet.
    expect(decodePacket(Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 40, 65]))).toBeUndefined();
  });
});

describe('what this computer says', () => {
  it('keeps the TXT record free of anything that opens the room', () => {
    const txt = txtRecord({ name: 'Studio', relayUrl: 'ws://100.101.102.103:4400' });
    expect(txt).toEqual(['v=1', 'name=Studio', 'relay=ws://100.101.102.103:4400']);
    expect(txt.join(' ')).not.toMatch(/room|key|pair|secret|code/i);
    expect(txtRecord({ name: 'Studio' })).toEqual(['v=1', 'name=Studio']);
  });

  it('makes safe instance and host labels from the computer name', () => {
    expect(serviceLabel('Philip’s MacBook Pro.local')).toBe('Philip’s MacBook Pro');
    expect(serviceLabel('a.b\u0001c')).toBe('a b c');
    expect(serviceLabel('')).toBe('Nekko Agent');
    expect(Buffer.byteLength(serviceLabel('猫'.repeat(40)))).toBeLessThanOrEqual(63);
    expect(hostLabel('Philip’s MacBook Pro.local')).toBe('philip-s-macbook-pro');
    expect(hostLabel('desktop-1.corp.example')).toBe('desktop-1');
    expect(hostLabel('…')).toBe('nekko-agent');
  });

  it('lists LAN addresses only: no loopback, IPv6 or tailnet', () => {
    expect(
      lanAddresses({
        lo: [nic('127.0.0.1', true)],
        en0: [nic('192.168.1.20'), { ...nic('fe80::1'), family: 'IPv6' } as NetworkInterfaceInfo],
        utun4: [nic('100.101.102.103')],
      }),
    ).toEqual(['192.168.1.20']);
  });

  it('answers a browse with the whole service, and ignores other names', () => {
    const browse = answersFor(ad, [{ name: SERVICE_TYPE, type: PTR, unicast: false }]);
    expect(browse.map((r) => r.type).sort()).toEqual([A, PTR, TXT, SRV].sort());
    expect(answersFor(ad, [{ name: '_services._dns-sd._udp.local', type: PTR, unicast: false }])).toEqual([
      { name: '_services._dns-sd._udp.local', type: PTR, ttl: 4500, data: SERVICE_TYPE },
    ]);
    expect(answersFor(ad, [{ name: 'studio.local', type: A, unicast: false }]).map((r) => r.data)).toEqual(['192.168.1.20']);
    expect(answersFor(ad, [{ name: '_airplay._tcp.local', type: PTR, unicast: false }])).toEqual([]);
  });
});

class FakeSocket implements MdnsSocket {
  sent: { msg: Buffer; port: number; address: string }[] = [];
  closed = false;
  private onMessage?: (msg: Buffer, from: RemoteInfo) => void;
  on(event: string, fn: never): unknown {
    if (event === 'message') this.onMessage = fn;
    return this;
  }
  send(msg: Buffer, port: number, address: string): void {
    this.sent.push({ msg, port, address });
  }
  close(): void {
    this.closed = true;
  }
  ask(questions: { name: string; type: number; unicast?: boolean }[], port = 5353, id = 0) {
    const msg = encodePacket({ id, questions: questions.map((q) => ({ unicast: false, ...q })) });
    this.onMessage?.(msg, { address: '192.168.1.50', port, family: 'IPv4', size: msg.length });
  }
  last() {
    const s = this.sent.at(-1)!;
    return { ...s, packet: decodePacket(s.msg)! };
  }
}

describe('NetworkVisibility', () => {
  const made: NetworkVisibility[] = [];
  afterEach(() => made.splice(0).forEach((v) => v.close()));

  const make = (overrides: { relay?: () => { url?: string; port?: number } | undefined; ifaces?: NodeJS.Dict<NetworkInterfaceInfo[]> } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-visible-'));
    const socket = new FakeSocket();
    const v = new NetworkVisibility({
      stateFile: join(dir, 'network-visibility.json'),
      interfaces: () => overrides.ifaces ?? { en0: [nic('192.168.1.20')] },
      hostName: () => 'Studio.local',
      relay: overrides.relay,
      openSocket: async () => socket,
      watchMs: 60_000,
    });
    made.push(v);
    return { v, socket, stateFile: join(dir, 'network-visibility.json') };
  };

  it('is off until switched on, and says nothing while off', async () => {
    const { v, socket } = make();
    v.resume();
    expect(v.status()).toMatchObject({ enabled: false, advertising: false });
    expect(socket.sent).toEqual([]);
  });

  it('announces when switched on, remembers it, and says goodbye when switched off', async () => {
    const { v, socket, stateFile } = make({ relay: () => ({ url: 'ws://studio.tail1234.ts.net:4400', port: 4400 }) });
    const on = await v.start();
    expect(on).toMatchObject({ enabled: true, advertising: true, name: 'Studio', addresses: ['192.168.1.20'], relayUrl: 'ws://studio.tail1234.ts.net:4400' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: true });
    const hello = socket.last();
    expect(hello.address).toBe('224.0.0.251');
    expect(hello.packet.answers.find((r) => r.type === SRV)?.data).toEqual({ port: 4400, target: 'studio.local' });

    const off = await v.stop();
    expect(off).toMatchObject({ enabled: false, advertising: false });
    expect(socket.last().packet.answers.every((r) => r.ttl === 0)).toBe(true);
    expect(socket.closed).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ enabled: false });
  });

  it('answers questions about itself: multicast, QU and legacy unicast', async () => {
    const { v, socket } = make();
    await v.start();
    const before = socket.sent.length;

    socket.ask([{ name: '_airplay._tcp.local', type: PTR }]);
    expect(socket.sent.length).toBe(before);

    socket.ask([{ name: SERVICE_TYPE, type: PTR }]);
    expect(socket.last().address).toBe('224.0.0.251');
    expect(socket.last().packet.answers.find((r) => r.type === TXT)?.data).toEqual(['v=1', 'name=Studio']);

    socket.ask([{ name: SERVICE_TYPE, type: PTR, unicast: true }]);
    expect(socket.last()).toMatchObject({ address: '192.168.1.50', port: 5353 });

    socket.ask([{ name: SERVICE_TYPE, type: PTR }], 49152, 77);
    const legacy = socket.last();
    expect(legacy).toMatchObject({ address: '192.168.1.50', port: 49152 });
    expect(legacy.packet.id).toBe(77);
    expect(legacy.packet.questions).toHaveLength(1);
    expect(legacy.packet.answers.every((r) => r.ttl <= 10)).toBe(true);
  });

  it('waits for a local network instead of advertising nothing', async () => {
    const { v, socket } = make({ ifaces: { lo: [nic('127.0.0.1', true)] } });
    const s = await v.start();
    expect(s).toMatchObject({ enabled: true, advertising: false });
    expect(s.error).toMatch(/local network/);
    expect(socket.sent).toEqual([]);
  });

  it('reports a port it cannot open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-visible-'));
    const v = new NetworkVisibility({
      stateFile: join(dir, 'state.json'),
      interfaces: () => ({ en0: [nic('192.168.1.20')] }),
      hostName: () => 'Studio',
      openSocket: async () => {
        throw new Error('bind EACCES');
      },
    });
    made.push(v);
    const s = await v.start();
    expect(s).toMatchObject({ enabled: true, advertising: false });
    expect(s.error).toMatch(/UDP 5353.*EACCES/);
  });
});
