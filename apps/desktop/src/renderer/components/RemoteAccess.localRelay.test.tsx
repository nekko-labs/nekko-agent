import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalRelayStatus } from '@nekko-agent/shared';
import { LocalRelayView } from './RemoteAccess.js';

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

  it('shows why a switched-on relay is not running', () => {
    const out = html({ ...base, enabled: true, tailnetIp: '100.101.102.103', error: 'Port 4400 is already in use on this computer.' });
    expect(out).toContain('Port 4400 is already in use');
  });
});
