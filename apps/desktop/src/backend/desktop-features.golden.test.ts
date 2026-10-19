import { readFileSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiServerBindHost,
  apiServerClientUrl,
  apiServerRefusal,
  apiServerUrl,
  withApiServerDefaults,
  type ApiServerSettings,
} from '@nekko-agent/shared';
import { launcherScript } from '../main/cli-install.js';
import { parseWebhookPayload } from '../main/workflow-listener.js';
import { isVirtualAdapter, localRelayUrl, readyLine, relayFailure, relayLanAddresses, tailnetAddress } from './local-relay.js';
import {
  answersFor,
  decodePacket,
  encodePacket,
  hostLabel,
  lanAddresses,
  recordsFor,
  serviceLabel,
  txtRecord,
  type Advertisement,
  type MdnsQuestion,
} from './network-visibility.js';

/**
 * The desktop-only features nekkod took over from the TS backend (PF14 step 5
 * prep, part 6), held to the TS functions by one golden set the Rust ports
 * match (crates/nekkod/tests/golden/desktop-features.json): the local API
 * server's address rules, the CLI launcher, the webhook body, the local
 * relay's address and failure text, and the mDNS responder's labels, records
 * and wire format (packets as hex). Fails when stale; rewrite with
 * UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'desktop-features.json');

function check(actual: unknown): void {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(text));
}

const nic = (address: string, internal = false, family = 'IPv4'): NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;

/** What a test hands `networkInterfaces`: named lists, in order. */
const IFACES: Record<string, Record<string, [string, boolean, string?][]>> = {
  none: {},
  loopbackOnly: { lo: [['127.0.0.1', true]] },
  lan: { lo: [['127.0.0.1', true]], en0: [['fe80::1', false, 'IPv6'], ['192.168.1.20', false]] },
  tailnetFirst: { tailscale0: [['100.101.102.103', false]], en0: [['10.0.0.5', false]] },
  tailnetEdges: { a: [['100.63.255.255', false], ['100.128.0.1', false], ['100.64.0.0', false], ['100.127.255.255', false]] },
  twoLans: { en0: [['192.168.1.20', false]], en1: [['172.16.4.2', false], ['100.64.1.1', false]], lo: [['127.0.0.1', true]] },
  internalTailnet: { lo: [['100.100.1.1', true]], wg: [['100.100.1.2', false, 'IPv6']] },
  lanEdges: {
    en0: [['169.254.1.1', false], ['172.32.0.1', false], ['8.8.8.8', false], ['10.255.255.255', false], ['192.168.1.20', false]],
    en1: [['192.168.1.20', false], ['10.0.0.1', true], ['172.31.0.1', false], ['fd12::5', false, 'IPv6']],
  },
  // VMs and containers: their private addresses are not the phone's Wi-Fi.
  winVirtual: { 'vEthernet (WSL (Hyper-V firewall))': [['192.168.0.1', false]], Ethernet: [['192.168.50.100', false]], Tailscale: [['100.114.173.86', false]] },
  linuxBridges: { docker0: [['172.17.0.1', false]], 'br-1a2b3c': [['172.18.0.1', false]], eth0: [['10.0.0.7', false]], virbr0: [['192.168.122.1', false]] },
};

function ifaces(name: string): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return Object.fromEntries(Object.entries(IFACES[name]).map(([k, list]) => [k, list.map(([a, i, f]) => nic(a, i, f))]));
}

const API_SETTINGS: Partial<ApiServerSettings>[] = [
  {},
  { token: 'tok' },
  { token: 'tok', bind: 'lan' },
  { token: 'tok', bind: 'custom', host: ' 192.168.1.20 ' },
  { token: 'tok', bind: 'custom', host: '' },
  { token: 'tok', bind: 'custom', host: '::1' },
  { token: 'tok', bind: 'custom', host: '::' },
  { token: 'tok', bind: 'custom', host: '0.0.0.0' },
  { token: 'tok', port: 80 },
  { token: 'tok', port: 1023 },
  { token: 'tok', port: 1024 },
  { token: 'tok', port: 65535 },
  { token: 'tok', port: 65536 },
  { token: 'tok', port: 1439.5 },
  { token: '   ' },
  { token: 'tok', advertisedUrl: 'http://nekko.tailnet.ts.net:1439///' },
  { token: 'tok', advertisedUrl: '  HTTPS://x  ' },
  { token: 'tok', advertisedUrl: 'nekko.local:1439' },
  { token: 'tok', advertisedUrl: 'http:// spaced' },
  { token: 'tok', advertisedUrl: '   ' },
  { enabled: false, startOnLaunch: false, token: 'tok', extra: 1 } as Partial<ApiServerSettings>,
  { token: 'tok', bind: 'weird' as ApiServerSettings['bind'] },
];

function apiServer() {
  return API_SETTINGS.map((input) => {
    const s = withApiServerDefaults(input);
    return {
      input,
      settings: s,
      bindHost: apiServerBindHost(s),
      url: apiServerUrl(s),
      urlLan: apiServerUrl(s, '192.168.1.20'),
      clientUrl: apiServerClientUrl(s),
      clientUrlLan: apiServerClientUrl(s, '192.168.1.20'),
      refusal: apiServerRefusal(s),
    };
  });
}

function withPlatform<T>(platform: string, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

function launchers() {
  const cases: [string, string, string][] = [
    ['win32', 'C:\\Program Files\\Nekko Agent\\Nekko Agent.exe', 'C:\\Program Files\\Nekko Agent\\resources\\cli\\nekko-agent-cli.cjs'],
    ['darwin', '/Applications/Nekko Agent.app/Contents/MacOS/Nekko Agent', '/Applications/Nekko Agent.app/Contents/Resources/cli/nekko-agent-cli.cjs'],
    ['linux', '/opt/Nekko Agent/nekko-agent', '/opt/Nekko Agent/resources/cli/nekko-agent-cli.cjs'],
  ];
  return cases.map(([platform, electron, cli]) => ({ platform, electron, cli, script: withPlatform(platform, () => launcherScript(electron, cli)) }));
}

const WEBHOOK_BODIES = ['{"ref":"main"}', '{"__raw":"x","a":1}', '[1,2]', '"text"', '42', 'null', 'not json', '{"a":', ' {"b":[true]} ', '{}'];

const RELAY_STDERR = [
  '',
  'NEKKO_RELAY_ERROR {"code":"EADDRINUSE","message":"listen EADDRINUSE"}\n',
  'noise\nNEKKO_RELAY_ERROR {"code":"EADDRNOTAVAIL"}\n',
  'NEKKO_RELAY_ERROR {"code":"EACCES"}',
  'NEKKO_RELAY_ERROR {not json}',
  'NEKKO_RELAY_ERROR {"message":"no code"}',
  'NEKKO_RELAY_ERROR {"code":"EADDRINUSE"} NEKKO_RELAY_ERROR {"code":"EACCES"}',
];

function relay() {
  return {
    tailnet: Object.keys(IFACES).map((name) => ({ ifaces: name, address: tailnetAddress(ifaces(name)) ?? null })),
    urls: [
      [undefined, '100.101.102.103', 4400],
      ['studio.tail1234.ts.net', '100.101.102.103', 4400],
      [undefined, '100.64.0.1', 9000],
    ].map(([name, ip, port]) => ({ name: name ?? null, ip, port, url: localRelayUrl(name as string | undefined, ip as string, port as number) })),
    // Where it listens besides the tailnet (TASKS.md IO-20): RFC 1918 only.
    lan: Object.keys(IFACES).map((name) => ({ ifaces: name, addresses: relayLanAddresses(ifaces(name)) })),
    adapters: ['en0', 'Ethernet', 'Wi-Fi', 'wlan0', 'eth0', 'vEthernet (Default Switch)', 'docker0', 'br-1a2b3c', 'veth12ab', 'virbr0', 'vmnet8', 'vboxnet0', 'VirtualBox Host-Only Network', 'VMware Network Adapter VMnet1', 'utun3', 'Tailscale', 'zt7nnig26', 'bridge0'].map((name) => ({ name, virtual: isVirtualAdapter(name) })),
    ready: RELAY_READY.map((out) => {
      const r = readyLine(out);
      return { out, ready: r ? { port: r.port ?? null, lan: r.lan } : null };
    }),
    failures: RELAY_STDERR.map((stderr) => ({ stderr, port: 4400, message: relayFailure(stderr, 4400) })),
  };
}

const RELAY_READY = [
  'NEKKO_RELAY_READY {"port":4400}',
  'NEKKO_RELAY_READY {"port":4400,"lan":["192.168.1.20","10.0.0.5"]}',
  'noise NEKKO_RELAY_READY {"port":0,"lan":["192.168.1.20",7,null]}',
  'NEKKO_RELAY_READY {"port":70000,"lan":"192.168.1.20"}',
  'NEKKO_RELAY_READY',
  'NEKKO_RELAY_READY {not json}',
  'nothing here',
];

const LABELS = [
  'Studio',
  'studio.local',
  'Studio.local.',
  'My.Mac.Book',
  '  spaced\tout\nname  ',
  '',
  '...',
  "Philip's MacBook Pro",
  'DESKTOP-ABC123',
  '\u0000ctl\u007f',
  '\u00a0nbsp\u2003em\u00a0',
  'ünïcödé-host',
  'İstanbul',
  '--dash--',
  'a'.repeat(70),
  'é'.repeat(40),
  `${'a'.repeat(60)}😀`,
  `${'a'.repeat(61)}😀`,
  `${'a'.repeat(59)}😀😀`,
  'host_name.with.dots',
];

const AD: Advertisement = { name: 'Studio', host: 'studio', addresses: ['192.168.1.20'], port: 0 };
const ADS: Advertisement[] = [
  AD,
  { ...AD, relayUrl: 'ws://studio.tail1234.ts.net:4400', port: 4400 },
  { name: "Philip's MacBook", host: 'philips-macbook', addresses: ['192.168.1.20', '10.0.0.5'], port: 0 },
  { name: 'Ünï', host: 'uni', addresses: [], port: 0 },
];

const PTR = 12;
const SRV = 33;
const TXT = 16;
const A = 1;
const ANY = 255;

const QUESTIONS: MdnsQuestion[][] = [
  [{ name: '_nekko-agent._tcp.local', type: PTR, unicast: false }],
  [{ name: '_NEKKO-AGENT._TCP.LOCAL', type: ANY, unicast: true }],
  [{ name: '_services._dns-sd._udp.local', type: PTR, unicast: false }],
  [{ name: '_services._dns-sd._udp.local', type: ANY, unicast: false }, { name: '_services._dns-sd._udp.local', type: PTR, unicast: false }],
  [{ name: '_services._dns-sd._udp.local', type: SRV, unicast: false }],
  [{ name: 'Studio._nekko-agent._tcp.local', type: SRV, unicast: false }],
  [{ name: 'Studio._nekko-agent._tcp.local', type: TXT, unicast: false }, { name: 'studio.local', type: A, unicast: false }],
  [{ name: 'studio.local', type: ANY, unicast: false }],
  [{ name: 'other.local', type: A, unicast: false }],
  [{ name: 'Studio._nekko-agent._tcp.local', type: ANY, unicast: false }, { name: '_nekko-agent._tcp.local', type: PTR, unicast: false }],
  [],
];

const hex = (b: Buffer) => b.toString('hex');
const label = (s: string) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
const head = (qd: number, an: number, flags = 0, id = 0) => {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(an, 6);
  return h;
};
const service = Buffer.concat([label('_nekko-agent'), label('_tcp'), label('local'), Buffer.from([0])]);

/** Packets as they arrive from the network, hand-built, malformed ones included. */
const RAW_PACKETS: Record<string, Buffer> = {
  short: Buffer.from([1, 2, 3]),
  empty: head(0, 0),
  ptrQuestionQu: Buffer.concat([head(1, 0), service, Buffer.from([0, PTR, 0x80, 1])]),
  compressed: Buffer.concat([head(2, 0), service, Buffer.from([0, PTR, 0x80, 1]), label('Studio'), Buffer.from([0xc0, 12, 0, SRV, 0, 1])]),
  selfPointer: Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]),
  labelPastEnd: Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 40, 65]),
  pointerPastEnd: Buffer.concat([head(1, 0), Buffer.from([0xc0])]),
  nameNoType: Buffer.concat([head(1, 0), service]),
  thirtyTwoLabels: Buffer.concat([head(1, 0), ...Array.from({ length: 32 }, () => label('a')), Buffer.from([0, 0, 1, 0, 1])]),
  thirtyOneLabels: Buffer.concat([head(1, 0), ...Array.from({ length: 31 }, () => label('a')), Buffer.from([0, 0, 1, 0, 1])]),
  invalidUtf8: Buffer.concat([head(1, 0), Buffer.from([3, 0xff, 0xfe, 0x41]), Buffer.from([0, 0, 1, 0, 1])]),
  extendedLabelBits: Buffer.concat([head(1, 0), Buffer.from([0x41, 0x41]), Buffer.from([0, 0, 1, 0, 1])]),
  response: Buffer.concat([head(0, 1, 0x8400, 7), service, Buffer.from([0, PTR, 0, 1, 0, 0, 0x11, 0x94, 0, 2, 0xc0, 12])]),
  txtOverrun: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, TXT, 0x80, 1, 0, 0, 0, 10, 0, 3, 2, 0x61, 0x62]), Buffer.from('trailing')]),
  txtEmptyEntries: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, TXT, 0, 1, 0, 0, 0, 10, 0, 4, 0, 1, 0x7a, 0])]),
  srvShort: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, SRV, 0, 1, 0, 0, 0, 10, 0, 2, 0, 0])]),
  srvTargetPointer: Buffer.concat([head(0, 1, 0x8400), service, Buffer.from([0, SRV, 0x80, 1, 0, 0, 0, 120, 0, 8, 0, 0, 0, 0, 0x11, 0x30, 0xc0, 12])]),
  aWrongLength: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, A, 0, 1, 0, 0, 0, 10, 0, 3, 1, 2, 3])]),
  unknownType: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, 99, 0, 1, 0, 0, 0, 10, 0, 2, 9, 9])]),
  rdataPastEnd: Buffer.concat([head(0, 1, 0x8400), Buffer.from([0]), Buffer.from([0, A, 0, 1, 0, 0, 0, 10, 0, 4, 1, 2])]),
  answerCountTooHigh: Buffer.concat([head(1, 2), service, Buffer.from([0, PTR, 0, 1])]),
};

function mdns() {
  return {
    // As the UTF-8 bytes the label goes out as: trimming can leave half a surrogate pair, which JSON cannot carry.
    labels: LABELS.map((raw) => ({ raw, service: Buffer.from(serviceLabel(raw), 'utf8').toString('hex'), host: hostLabel(raw) })),
    lanAddresses: Object.keys(IFACES).map((name) => ({ ifaces: name, addresses: lanAddresses(ifaces(name)) })),
    txt: ADS.map((ad) => txtRecord(ad)),
    records: ADS.map((ad) => ({
      ad,
      records: recordsFor(ad),
      announce: hex(encodePacket({ response: true, answers: recordsFor(ad) })),
      goodbye: hex(encodePacket({ response: true, answers: recordsFor(ad, 0) })),
    })),
    answers: QUESTIONS.map((questions) => {
      const answers = answersFor(ADS[1], questions);
      const short = answers.map((r) => ({ ...r, ttl: Math.min(r.ttl, 10), unique: false }));
      return {
        questions,
        answers,
        multicast: hex(encodePacket({ response: true, answers })),
        legacy: hex(encodePacket({ id: 0x1234, response: true, questions, answers: short })),
      };
    }),
    query: hex(encodePacket({ questions: QUESTIONS[1] })),
    decode: Object.entries(RAW_PACKETS).map(([name, buf]) => ({ name, hex: hex(buf), packet: decodePacket(buf) ?? null })),
  };
}

describe('desktop features golden', () => {
  it('matches the TS desktop backend', () => {
    check({
      // `[address, internal, family?]` per interface name, as the cases below name them.
      ifaces: IFACES,
      apiServer: apiServer(),
      launchers: launchers(),
      webhookBodies: WEBHOOK_BODIES.map((raw) => ({ raw, payload: parseWebhookPayload(raw) })),
      relay: relay(),
      mdns: mdns(),
    });
  });
});
