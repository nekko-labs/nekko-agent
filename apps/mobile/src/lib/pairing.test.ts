import { describe, expect, it } from 'vitest';
import { parsePairingLink, relayHost } from './pairing';

const RELAY = 'wss://nekko-agent-relay.fly.dev';
const q = `relay=${encodeURIComponent(RELAY)}&room=a1b2c3d4e5f60718&key=0123456789abcdef0123456789abcdef&pair=abcd2345`;

describe('parsePairingLink', () => {
  it('reads the desktop QR form', () => {
    expect(parsePairingLink(`nekko-agent-pair:?${q}`)).toEqual({
      relayUrl: RELAY,
      room: 'a1b2c3d4e5f60718',
      key: '0123456789abcdef0123456789abcdef',
      pair: 'ABCD2345',
      alts: [],
    });
  });

  it('reads the Local Web UI link and a bare query', () => {
    expect(parsePairingLink(`https://nekko.local:1440/?${q}#x`)?.room).toBe('a1b2c3d4e5f60718');
    expect(parsePairingLink(q)?.relayUrl).toBe(RELAY);
  });

  it('keeps a pairing without a code (already enrolled)', () => {
    expect(parsePairingLink(q.replace(/&pair=[^&]+/, ''))?.pair).toBeUndefined();
  });

  it('refuses links that are not pairing links', () => {
    expect(parsePairingLink('')).toBeNull();
    expect(parsePairingLink('https://nekkoagent.com')).toBeNull();
    expect(parsePairingLink(q.replace(encodeURIComponent(RELAY), encodeURIComponent('https://evil.example')))).toBeNull();
    expect(parsePairingLink(q.replace('a1b2c3d4e5f60718', 'not hex!'))).toBeNull();
  });

  it('shows the relay host', () => {
    expect(relayHost(RELAY)).toBe('nekko-agent-relay.fly.dev');
    expect(relayHost('ws://127.0.0.1:4455/')).toBe('127.0.0.1:4455');
  });
});

describe('alt routes (IO-20)', () => {
  it('parses the shared fixture exactly as the computer does', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(__dirname, '..', '..', '..', 'ios', 'Protocol', 'Tests', 'NekkoProtocolTests', 'Fixtures', 'pairing-links.json');
    const cases = JSON.parse(readFileSync(path, 'utf8')) as { input: string; link: unknown }[];
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect([c.input, parsePairingLink(c.input)]).toEqual([c.input, c.link]);
  });
});
