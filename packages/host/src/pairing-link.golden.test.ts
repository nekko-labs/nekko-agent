import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pairingLink, parsePairingLink } from '@nekko-agent/shared';

const ROOM = '0123456789abcdef';
const KEY = '00112233445566778899aabbccddeeff';
const base = `nekko-agent-pair:?relay=ws%3A%2F%2Fstudio.tail1234.ts.net%3A4400&room=${ROOM}&key=${KEY}`;

/** Every phone parser reads these and must agree (TASKS.md IO-20). */
const CASES: string[] = [
  base,
  `${base}&pair=ab12cd`,
  `${base}&alt=ws%3A%2F%2F192.168.1.20%3A4400`,
  `${base}&alt=ws%3A%2F%2F192.168.1.20%3A4400%2F&alt=ws://10.0.0.5:4400&pair=XY`,
  // PH1: plain ws:// to the open internet is dropped; so is anything not ws(s).
  `${base}&alt=ws%3A%2F%2F8.8.8.8%3A4400&alt=http%3A%2F%2F192.168.1.20&alt=&alt=wss%3A%2F%2Frelay.example.com`,
  // The relay itself and repeats are dropped.
  `${base}&alt=ws%3A%2F%2Fstudio.tail1234.ts.net%3A4400&alt=ws://10.0.0.5:4400&alt=ws://10.0.0.5:4400/`,
  // At most four.
  `${base}&alt=ws://10.0.0.1:1&alt=ws://10.0.0.2:1&alt=ws://10.0.0.3:1&alt=ws://10.0.0.4:1&alt=ws://10.0.0.5:1`,
  `${base}&alt=ws%3A%2F%2F%5Bfd12%3A%3A5%5D%3A4400`,
  `https://studio.local:1439/?relay=wss%3A%2F%2Frelay.example.com&room=${ROOM}&key=${KEY}&alt=ws%3A%2F%2F172.16.4.2%3A4400#x`,
  `relay=ws://100.101.102.103:4400&room=${ROOM}&key=${KEY}&alt=ws://192.168.50.100:4400`,
  // A broken link stays broken, alt or not.
  `nekko-agent-pair:?relay=http%3A%2F%2Fx&room=${ROOM}&key=${KEY}&alt=ws://10.0.0.5:4400`,
  `nekko-agent-pair:?alt=ws://10.0.0.5:4400&room=${ROOM}&key=${KEY}`,
];

const fixture = join(__dirname, '..', '..', '..', 'apps', 'ios', 'Protocol', 'Tests', 'NekkoProtocolTests', 'Fixtures', 'pairing-links.json');
const androidCopy = join(__dirname, '..', '..', '..', 'apps', 'android', 'protocol', 'src', 'test', 'resources', 'pairing-links.json');

describe('pairing links', () => {
  it('parse the same way on every phone (fixture; UPDATE_GOLDEN=1 rewrites it)', () => {
    const golden = CASES.map((input) => ({ input, link: parsePairingLink(input) }));
    const text = `${JSON.stringify(golden, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(fixture, text);
      writeFileSync(androidCopy, text);
    }
    expect(JSON.parse(readFileSync(fixture, 'utf8'))).toEqual(JSON.parse(text));
    expect(readFileSync(androidCopy, 'utf8')).toBe(readFileSync(fixture, 'utf8'));
  });

  it('keeps old links as they were, with no routes beyond the relay', () => {
    expect(parsePairingLink(`${base}&pair=ab12cd`)).toEqual({
      relayUrl: 'ws://studio.tail1234.ts.net:4400',
      room: ROOM,
      key: KEY,
      pair: 'AB12CD',
      alts: [],
    });
  });

  it('keeps LAN routes and drops the ones the phone must refuse', () => {
    expect(parsePairingLink(CASES[4])?.alts).toEqual(['wss://relay.example.com']);
    expect(parsePairingLink(CASES[5])?.alts).toEqual(['ws://10.0.0.5:4400']);
    expect(parsePairingLink(CASES[6])?.alts).toHaveLength(4);
  });

  it('trims a long run of slashes in linear time (no ReDoS)', () => {
    const slashes = '/'.repeat(100_000);
    const start = Date.now();
    const link = parsePairingLink(`relay=ws://10.0.0.5:4400${slashes}x${slashes}&room=${ROOM}&key=${KEY}&alt=ws://10.0.0.6:4400${slashes}`);
    expect(Date.now() - start).toBeLessThan(500);
    expect(link?.relayUrl).toBe(`ws://10.0.0.5:4400${slashes}x`);
    expect(link?.alts).toEqual(['ws://10.0.0.6:4400']);
  });

  it('builds what it parses', () => {
    const link = pairingLink('nekko-agent-pair:', {
      relayUrl: 'ws://studio.tail1234.ts.net:4400',
      room: ROOM,
      key: KEY,
      pair: 'AB12CD',
      alts: ['ws://192.168.1.20:4400', 'ws://8.8.8.8:4400', 'ws://studio.tail1234.ts.net:4400'],
    });
    expect(link).toBe(`${base}&pair=AB12CD&alt=ws%3A%2F%2F192.168.1.20%3A4400`);
    expect(parsePairingLink(link)?.alts).toEqual(['ws://192.168.1.20:4400']);
    expect(pairingLink('nekko-agent-pair:', { relayUrl: 'wss://r.example.com', room: ROOM, key: KEY })).toBe(
      `nekko-agent-pair:?relay=wss%3A%2F%2Fr.example.com&room=${ROOM}&key=${KEY}`,
    );
  });
});
