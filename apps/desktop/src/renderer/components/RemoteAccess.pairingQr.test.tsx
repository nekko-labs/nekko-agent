import { describe, expect, it, vi } from 'vitest';
import { pairingLink } from '@nekko-agent/shared';
import { PAIRING_QR_SIZE, pairingQr } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

// A realistic link: tailnet relay, 88-character host key, one-time code, two LAN routes.
const link = pairingLink('nekko-agent-pair:', {
  relayUrl: 'ws://100.101.102.103:8787',
  room: 'a1b2c3d4e5f60718',
  key: '00112233445566778899aabbccddeeff',
  hostKey: `B${'A'.repeat(40)}+/${'x'.repeat(44)}=`,
  pair: 'ABCD-EFGH',
  alts: ['ws://192.168.1.20:8787', 'ws://10.0.0.5:8787'],
});

const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1));

describe('pairingQr', () => {
  it('is a sharp SVG, not a scaled bitmap', async () => {
    const url = await pairingQr(link);
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(svgOf(url)).toContain('crispEdges');
  });

  // Phones were slow to read the code: at 132 px a module was about 2 px.
  it('draws each module at least 3.5 CSS px', async () => {
    const svg = svgOf(await pairingQr(link));
    const side = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
    expect(side).toBeGreaterThan(0);
    expect(PAIRING_QR_SIZE / side).toBeGreaterThanOrEqual(3.5);
  });
});
