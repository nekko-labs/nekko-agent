import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalRelayStatus } from '@nekko-agent/shared';
import { LocalRelayView, pairingAlts } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

const base: LocalRelayStatus = { available: true, running: false, enabled: false, port: 4400 };
const html = (relay: LocalRelayStatus, extra: Partial<React.ComponentProps<typeof LocalRelayView>> = {}) =>
  renderToStaticMarkup(<LocalRelayView relay={relay} onToggle={vi.fn()} {...extra} />);

describe('Relay on this computer', () => {
  it('offers to start when Tailscale is connected, naming the tailnet', () => {
    const out = html({ ...base, tailnetIp: '100.101.102.103', tailnetName: 'studio.tail1234.ts.net' });
    expect(out).toContain('Relay on this computer');
    expect(out).toContain('Start relay');
    expect(out).toContain('Tailscale connected');
    expect(out).toContain('studio.tail1234.ts.net');
    expect(out).not.toContain('Use this relay');
  });

  it('says Tailscale is missing and links to it instead of binding anywhere else', () => {
    const out = html({ ...base, error: "Tailscale isn't connected on this computer." });
    expect(out).toContain('Tailscale isn’t connected on this computer.');
    expect(out).toContain('https://tailscale.com/download');
    expect(out).toContain('start the relay.');
    // The Tailscale line already says it; the raw error is not repeated.
    expect(out).not.toContain("Tailscale isn't connected on this computer.");
  });

  it('waits for Tailscale once switched on', () => {
    const out = html({ ...base, enabled: true });
    expect(out).toContain('waiting');
    expect(out).toContain('the relay starts by itself.');
    expect(out).toContain('>Stop<');
  });

  it('shows the address phones use and fills the relay field', () => {
    const relay = { ...base, enabled: true, running: true, tailnetIp: '100.101.102.103', tailnetName: 'studio.tail1234.ts.net', url: 'ws://studio.tail1234.ts.net:4400' };
    const before = html(relay, { onUse: vi.fn() });
    expect(before).toContain('ws://studio.tail1234.ts.net:4400');
    expect(before).toContain('Use this relay');
    expect(before).toContain('running');

    const after = html(relay, { inUse: 'ws://studio.tail1234.ts.net:4400' });
    expect(after).toContain('Remote access is using this relay.');
    expect(after).not.toContain('Use this relay');
  });

  it('has a switch for the LAN, on by default, listing the LAN addresses phones get (IO-20)', () => {
    const relay = { ...base, enabled: true, running: true, tailnetIp: '100.101.102.103', url: 'ws://100.101.102.103:4400', lanUrls: ['ws://192.168.1.20:4400'] };
    const on = html(relay, { onLan: vi.fn() });
    expect(on).toContain('Also on this Wi-Fi');
    expect(on).toContain('role="switch" aria-checked="true"');
    expect(on).toContain('ws://192.168.1.20:4400');
    expect(on).toContain('and on this computer’s private network addresses');

    const off = html({ ...relay, lan: false, lanUrls: [] }, { onLan: vi.fn() });
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('Listens on the tailnet address only.');
    expect(off).not.toContain('ws://192.168.1.20:4400');
    // Without a handler (an edition that can't), no switch.
    expect(html(relay)).not.toContain('Also on this Wi-Fi');
  });

  it('puts the LAN routes in pairing links only for the relay on this computer', () => {
    const local = { ...base, enabled: true, running: true, tailnetIp: '100.101.102.103', tailnetName: 'studio.tail1234.ts.net', lanUrls: ['ws://192.168.1.20:4400'] };
    expect(pairingAlts('ws://studio.tail1234.ts.net:4400', local)).toEqual(['ws://192.168.1.20:4400']);
    expect(pairingAlts('ws://100.101.102.103:4400/', local)).toEqual(['ws://192.168.1.20:4400']);
    expect(pairingAlts('ws://studio.tail1234.ts.net:4401', local)).toEqual([]);
    expect(pairingAlts('wss://nekko-agent-relay.fly.dev', local)).toEqual([]);
    expect(pairingAlts('ws://studio.tail1234.ts.net:4400', { ...local, running: false })).toEqual([]);
    expect(pairingAlts('ws://studio.tail1234.ts.net:4400', null)).toEqual([]);
  });

  it('shows why a switched-on relay is not running', () => {
    const out = html({ ...base, enabled: true, tailnetIp: '100.101.102.103', error: 'Port 4400 is already in use on this computer.' });
    expect(out).toContain('Port 4400 is already in use');
  });
});
