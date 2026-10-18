import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname } from 'node:path';
import type { NetworkVisibilityStatus } from '@nekko-agent/shared';

/**
 * "Visible on this network" (TASKS.md PH2): the desktop answers mDNS / DNS-SD
 * for `_nekko-agent._tcp.local`, so a phone on the same Wi-Fi can list this
 * computer by name instead of the user hunting for its QR code.
 *
 * Off by default. What it says is readable by anyone on the network, so the
 * TXT record carries only the computer's name, the relay address phones would
 * dial (when this computer runs its own relay, else nothing), and a version.
 * Never the room, the key or a pairing code: getting into the room still
 * takes the QR code or link (how a phone pairs from a listing is the PH2/PH3
 * decision in reports/phone-discovery-pairing-proposal.md).
 *
 * A small responder on plain `dgram` multicast, no native modules: it answers
 * questions about its own records, announces on start and on changes, and
 * says goodbye (TTL 0) on stop.
 */

export const SERVICE_TYPE = '_nekko-agent._tcp.local';
const SERVICES_ENUM = '_services._dns-sd._udp.local';
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
/** RFC 6762 §10: host records 120 s, the rest 75 minutes. */
const TTL_HOST = 120;
const TTL_OTHER = 4500;

export interface MdnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** Unique records (SRV, TXT, A) set the cache-flush bit. */
  unique?: boolean;
  data: string | string[] | { port: number; target: string };
}

export interface MdnsQuestion {
  name: string;
  type: number;
  /** The QU bit: the asker wants a unicast reply. */
  unicast: boolean;
}

export interface MdnsPacket {
  id: number;
  response: boolean;
  questions: MdnsQuestion[];
  answers: MdnsRecord[];
}

/* ------------------------------------------------------------------------- *
 * Wire format (RFC 1035 §4, RFC 6762). Names are written uncompressed; reads
 * follow compression pointers, with a hop limit so a looping packet can't hang.
 * ------------------------------------------------------------------------- */

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map((p) => {
    const label = Buffer.from(p, 'utf8').subarray(0, 63);
    return Buffer.concat([Buffer.from([label.length]), label]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeData(r: MdnsRecord): Buffer {
  switch (r.type) {
    case TYPE.A:
      return Buffer.from(String(r.data).split('.').map(Number));
    case TYPE.PTR:
      return encodeName(String(r.data));
    case TYPE.TXT: {
      const entries = (r.data as string[]).map((s) => {
        const b = Buffer.from(s, 'utf8').subarray(0, 255);
        return Buffer.concat([Buffer.from([b.length]), b]);
      });
      return entries.length ? Buffer.concat(entries) : Buffer.from([0]);
    }
    case TYPE.SRV: {
      const { port, target } = r.data as { port: number; target: string };
      const head = Buffer.alloc(6);
      head.writeUInt16BE(0, 0); // priority
      head.writeUInt16BE(0, 2); // weight
      head.writeUInt16BE(port, 4);
      return Buffer.concat([head, encodeName(target)]);
    }
    default:
      return Buffer.alloc(0);
  }
}

export function encodePacket(p: Partial<MdnsPacket>): Buffer {
  const questions = p.questions ?? [];
  const answers = p.answers ?? [];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(p.id ?? 0, 0);
  // Responses: QR + AA. mDNS queries carry no flags.
  head.writeUInt16BE(p.response ? 0x8400 : 0, 2);
  head.writeUInt16BE(questions.length, 4);
  head.writeUInt16BE(answers.length, 6);
  const parts: Buffer[] = [head];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(CLASS_IN | (q.unicast ? 0x8000 : 0), 2);
    parts.push(encodeName(q.name), tail);
  }
  for (const r of answers) {
    const data = encodeData(r);
    const tail = Buffer.alloc(10);
    tail.writeUInt16BE(r.type, 0);
    tail.writeUInt16BE(CLASS_IN | (r.unique ? CACHE_FLUSH : 0), 2);
    tail.writeUInt32BE(r.ttl, 4);
    tail.writeUInt16BE(data.length, 8);
    parts.push(encodeName(r.name), tail, data);
  }
  return Buffer.concat(parts);
}

function readName(buf: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = start;
  let end = -1;
  for (let hops = 0; hops < 32; hops++) {
    if (at >= buf.length) throw new Error('name past end');
    const len = buf[at];
    if (len === 0) {
      if (end < 0) end = at + 1;
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length) throw new Error('pointer past end');
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1];
      continue;
    }
    if (at + 1 + len > buf.length) throw new Error('label past end');
    labels.push(buf.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error('name loops');
}

function decodeData(buf: Buffer, type: number, at: number, len: number): MdnsRecord['data'] {
  switch (type) {
    case TYPE.A:
      return len === 4 ? [...buf.subarray(at, at + 4)].join('.') : '';
    case TYPE.PTR:
      return readName(buf, at).name;
    case TYPE.TXT: {
      const out: string[] = [];
      for (let i = at; i < at + len; ) {
        const n = buf[i];
        if (n > 0) out.push(buf.toString('utf8', i + 1, i + 1 + n));
        i += 1 + n;
      }
      return out;
    }
    case TYPE.SRV:
      return { port: buf.readUInt16BE(at + 4), target: readName(buf, at + 6).name };
    default:
      return '';
  }
}

/** Undefined for anything malformed: the network is not trusted. */
export function decodePacket(buf: Buffer): MdnsPacket | undefined {
  try {
    if (buf.length < 12) return undefined;
    const id = buf.readUInt16BE(0);
    const response = (buf.readUInt16BE(2) & 0x8000) !== 0;
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    let at = 12;
    const questions: MdnsQuestion[] = [];
    for (let i = 0; i < qd; i++) {
      const { name, end } = readName(buf, at);
      const type = buf.readUInt16BE(end);
      const cls = buf.readUInt16BE(end + 2);
      questions.push({ name, type, unicast: (cls & 0x8000) !== 0 });
      at = end + 4;
    }
    const answers: MdnsRecord[] = [];
    for (let i = 0; i < an; i++) {
      const { name, end } = readName(buf, at);
      const type = buf.readUInt16BE(end);
      const cls = buf.readUInt16BE(end + 2);
      const ttl = buf.readUInt32BE(end + 4);
      const len = buf.readUInt16BE(end + 8);
      const dataAt = end + 10;
      if (dataAt + len > buf.length) return undefined;
      answers.push({ name, type, ttl, unique: (cls & CACHE_FLUSH) !== 0, data: decodeData(buf, type, dataAt, len) });
      at = dataAt + len;
    }
    return { id, response, questions, answers };
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * What this computer says about itself.
 * ------------------------------------------------------------------------- */

export interface Advertisement {
  /** The instance label phones list, e.g. "Studio". */
  name: string;
  /** `<host>.local`, the SRV target. */
  host: string;
  /** This computer's LAN IPv4 addresses. */
  addresses: string[];
  /** The relay phones would dial, when this computer runs one (PH4). */
  relayUrl?: string;
  /** SRV port: the local relay's when running, else 0 (nothing to connect to directly). */
  port: number;
}

/** A DNS label safe for the instance and host name: printable, no dots, at most 63 bytes. */
export function serviceLabel(raw: string): string {
  const clean = raw
    .replace(/\.local\.?$/i, '')
    .replace(/[\u0000-\u001f\u007f.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let label = clean || 'Nekko Agent';
  while (Buffer.byteLength(label, 'utf8') > 63) label = label.slice(0, -1);
  return label;
}

/** Host labels are stricter than instance labels: letters, digits and hyphens. */
export function hostLabel(raw: string): string {
  const clean = raw
    .replace(/\.local\.?$/i, '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return clean || 'nekko-agent';
}

/** LAN IPv4 only: loopback is useless to a phone, and the tailnet has no multicast. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const [a, b] = i.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) continue;
      out.push(i.address);
    }
  }
  return out;
}

/** The TXT strings. Nothing that lets anyone into the room. */
export function txtRecord(ad: Pick<Advertisement, 'name' | 'relayUrl'>): string[] {
  const txt = ['v=1', `name=${ad.name}`];
  if (ad.relayUrl) txt.push(`relay=${ad.relayUrl}`);
  return txt;
}

export function recordsFor(ad: Advertisement, ttlScale = 1): MdnsRecord[] {
  const instance = `${ad.name}.${SERVICE_TYPE}`;
  const host = `${ad.host}.local`;
  return [
    { name: SERVICE_TYPE, type: TYPE.PTR, ttl: TTL_OTHER * ttlScale, data: instance },
    { name: instance, type: TYPE.SRV, ttl: TTL_HOST * ttlScale, unique: true, data: { port: ad.port, target: host } },
    { name: instance, type: TYPE.TXT, ttl: TTL_OTHER * ttlScale, unique: true, data: txtRecord(ad) },
    ...ad.addresses.map((a): MdnsRecord => ({ name: host, type: TYPE.A, ttl: TTL_HOST * ttlScale, unique: true, data: a })),
  ];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The records that answer [questions], or none when nothing asked is ours. */
export function answersFor(ad: Advertisement, questions: MdnsQuestion[]): MdnsRecord[] {
  const all = recordsFor(ad);
  const out = new Set<MdnsRecord>();
  for (const q of questions) {
    if (same(q.name, SERVICES_ENUM) && (q.type === TYPE.PTR || q.type === TYPE.ANY)) {
      out.add({ name: SERVICES_ENUM, type: TYPE.PTR, ttl: TTL_OTHER, data: SERVICE_TYPE });
      continue;
    }
    for (const r of all) if (same(r.name, q.name) && (q.type === r.type || q.type === TYPE.ANY)) out.add(r);
  }
  // A PTR answer is only useful with what it points at (RFC 6763 §12).
  if ([...out].some((r) => r.type === TYPE.PTR && r.name === SERVICE_TYPE)) all.forEach((r) => out.add(r));
  return [...out];
}

/* ------------------------------------------------------------------------- *
 * The switch, the socket.
 * ------------------------------------------------------------------------- */

export interface MdnsSocket {
  on(event: 'message', fn: (msg: Buffer, from: RemoteInfo) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  send(msg: Buffer, port: number, address: string): void;
  close(): void;
}

export interface NetworkVisibilityDeps {
  stateFile: string;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  hostName?: () => string;
  /** The relay to mention, when this computer runs one (PH4). */
  relay?: () => { url?: string; port?: number } | undefined;
  openSocket?: () => Promise<MdnsSocket>;
  /** How often to notice a new LAN address or relay and re-announce. */
  watchMs?: number;
}

function openMulticast(): Promise<MdnsSocket> {
  return new Promise((done, fail) => {
    const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', fail);
    socket.bind(MDNS_PORT, () => {
      socket.off('error', fail);
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
        // Join on every LAN interface: the default only joins one.
        const joined = lanAddresses(networkInterfaces()).filter((a) => {
          try {
            socket.addMembership(MDNS_GROUP, a);
            return true;
          } catch {
            return false;
          }
        });
        if (!joined.length) socket.addMembership(MDNS_GROUP);
      } catch (e) {
        socket.close();
        return fail(e);
      }
      done(socket);
    });
  });
}

interface Saved {
  enabled: boolean;
}

export class NetworkVisibility {
  private saved: Saved = { enabled: false };
  private socket: MdnsSocket | null = null;
  private opening: Promise<void> | null = null;
  private current: Advertisement | null = null;
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  private readonly hostName: () => string;
  private readonly openSocket: () => Promise<MdnsSocket>;

  constructor(private readonly deps: NetworkVisibilityDeps) {
    this.interfaces = deps.interfaces ?? networkInterfaces;
    this.hostName = deps.hostName ?? hostname;
    this.openSocket = deps.openSocket ?? openMulticast;
    try {
      const s = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as Partial<Saved>;
      this.saved = { enabled: s.enabled === true };
    } catch {
      // Never switched on.
    }
  }

  resume(): void {
    if (this.saved.enabled) void this.start();
  }

  status(): NetworkVisibilityStatus {
    const ad = this.socket ? this.current : null;
    return {
      available: true,
      enabled: this.saved.enabled,
      advertising: !!ad,
      name: ad?.name,
      addresses: ad?.addresses,
      relayUrl: ad?.relayUrl,
      error: this.socket ? undefined : this.error,
    };
  }

  async start(): Promise<NetworkVisibilityStatus> {
    if (!this.saved.enabled) this.save({ enabled: true });
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.deps.watchMs ?? 30_000);
      this.timer.unref?.();
    }
    await this.refresh();
    return this.status();
  }

  async stop(): Promise<NetworkVisibilityStatus> {
    this.save({ enabled: false });
    this.close();
    this.error = undefined;
    return this.status();
  }

  /** App shutdown: say goodbye, keep the switch as it is. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (this.current) this.send(socket, recordsFor(this.current, 0));
    this.current = null;
    socket.close();
  }

  private advertisement(): Advertisement {
    const raw = this.hostName();
    const relay = this.deps.relay?.();
    return {
      name: serviceLabel(raw),
      host: hostLabel(raw),
      addresses: lanAddresses(this.interfaces()),
      relayUrl: relay?.url,
      port: relay?.url ? relay.port ?? 0 : 0,
    };
  }

  /** Open the socket if needed and (re-)announce when what we say has changed. */
  private refresh(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (!this.saved.enabled) return;
      const next = this.advertisement();
      if (!next.addresses.length) {
        this.error = 'This computer isn’t on a local network right now. It becomes visible when it joins one.';
        if (this.socket && this.current) this.send(this.socket, recordsFor(this.current, 0));
        this.current = null;
        return;
      }
      if (!this.socket) {
        try {
          const socket = await this.openSocket();
          socket.on('message', (msg, from) => this.answer(socket, msg, from));
          socket.on('error', () => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.error = 'Advertising stopped after a network error. It retries on its own while this is on.';
            socket.close();
          });
          if (!this.saved.enabled) return socket.close();
          this.socket = socket;
          this.error = undefined;
        } catch (e) {
          this.error = `Couldn’t open the local network port (UDP ${MDNS_PORT}): ${(e as Error).message}`;
          return;
        }
      }
      const socket = this.socket;
      const changed = JSON.stringify(next) !== JSON.stringify(this.current);
      if (this.current && changed && (this.current.name !== next.name || this.current.host !== next.host)) {
        this.send(socket, recordsFor(this.current, 0));
      }
      this.current = next;
      if (changed) this.announce();
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** RFC 6762 §8.3: at least two unsolicited responses, a second apart. */
  private announce(): void {
    const socket = this.socket;
    const ad = this.current;
    if (!socket || !ad) return;
    this.send(socket, recordsFor(ad));
    setTimeout(() => {
      if (this.socket === socket && this.current === ad) this.send(socket, recordsFor(ad));
    }, 1000).unref?.();
  }

  private answer(socket: MdnsSocket, msg: Buffer, from: RemoteInfo): void {
    const ad = this.current;
    if (!ad || this.socket !== socket) return;
    const packet = decodePacket(msg);
    if (!packet || packet.response || !packet.questions.length) return;
    const answers = answersFor(ad, packet.questions);
    if (!answers.length) return;
    if (from.port !== MDNS_PORT) {
      // Legacy unicast (RFC 6762 §6.7): reply to the asker, echo id and questions, short TTLs.
      const short = answers.map((r) => ({ ...r, ttl: Math.min(r.ttl, 10), unique: false }));
      socket.send(encodePacket({ id: packet.id, response: true, questions: packet.questions, answers: short }), from.port, from.address);
      return;
    }
    if (packet.questions.every((q) => q.unicast)) {
      socket.send(encodePacket({ response: true, answers }), from.port, from.address);
      return;
    }
    this.send(socket, answers);
  }

  private send(socket: MdnsSocket, answers: MdnsRecord[]): void {
    try {
      socket.send(encodePacket({ response: true, answers }), MDNS_PORT, MDNS_GROUP);
    } catch {
      // A send can fail while an interface goes away; the next refresh retries.
    }
  }

  private save(next: Saved): void {
    this.saved = next;
    try {
      if (!existsSync(dirname(this.deps.stateFile))) mkdirSync(dirname(this.deps.stateFile), { recursive: true });
      writeFileSync(this.deps.stateFile, JSON.stringify(next));
    } catch {
      // Still works this session; it just won't come back by itself.
    }
  }
}
