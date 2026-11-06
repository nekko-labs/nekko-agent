import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalRelayStatus } from '@nekko-agent/shared';
import { CloudGoneBanner, connectionName, LocalRelayView, MANAGED_RELAY_URL, PairingChoiceView, relayToEnable } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

// Remote access offers two ways in: Tailscale (this computer's relay) or Nekko Cloud.
const tailnet: LocalRelayStatus = {
  available: true,
  running: false,
  enabled: false,
  port: 4400,
  tailnetIp: '100.114.173.86',
  tailnetName: 'gomi.tailfd6474.ts.net',
  url: 'ws://gomi.tailfd6474.ts.net:4400',
};

describe('PairingChoiceView', () => {
  const html = (local: LocalRelayStatus | null, cloudLive = true) =>
    renderToStaticMarkup(<PairingChoiceView local={local} relayUrl="" onRelayUrl={vi.fn()} onTailscale={vi.fn()} onCloud={vi.fn()} onOwnRelay={vi.fn()} cloudLive={cloudLive} />);

  it('marks Nekko Cloud coming soon and leads with Tailscale while the managed relay is down', () => {
    const out = html(tailnet, false);
    expect(out).toContain('Coming soon');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Use Nekko Cloud/);
    expect(out).toMatch(/<button class="btn btn-primary[^"]*"[^>]*>Use Tailscale/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Use Tailscale/);
  });

  it('offers Tailscale and Nekko Cloud, never naming the relay host', () => {
    const out = html(tailnet);
    expect(out).toContain('Use Tailscale');
    expect(out).toContain('Use Nekko Cloud');
    expect(out).toContain('gomi.tailfd6474.ts.net');
    expect(out).not.toContain('fly.dev');
  });

  it('links to Tailscale and disables it when it is not connected here', () => {
    const out = html({ available: true, running: false, enabled: false, port: 4400 });
    expect(out).toContain('https://tailscale.com/download');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Use Tailscale/);
  });

  it('shows only Nekko Cloud where this computer cannot run a relay', () => {
    expect(html({ ...tailnet, available: false })).not.toContain('Use Tailscale');
    expect(html(null)).toContain('Use Nekko Cloud');
  });
});

describe('connectionName', () => {
  it('calls the managed relay Nekko Cloud, this computer Tailscale, and anything else by its URL', () => {
    expect(connectionName(MANAGED_RELAY_URL, tailnet)).toBe('Nekko Cloud');
    expect(connectionName('ws://gomi.tailfd6474.ts.net:4400', tailnet)).toBe('Tailscale');
    expect(connectionName('ws://100.114.173.86:4400', tailnet)).toBe('Tailscale');
    expect(connectionName('wss://relay.example.com', tailnet)).toBe('wss://relay.example.com');
  });
});

describe('CloudGoneBanner', () => {
  it('says phones cannot connect and offers the way out', () => {
    const out = renderToStaticMarkup(<CloudGoneBanner onChange={vi.fn()} />);
    expect(out).toContain('phones can’t reach this computer');
    expect(out).toContain('Tailscale');
    expect(out).toMatch(/<button[^>]*>Change<\/button>/);
  });
});

describe('relayToEnable', () => {
  const fallback = { url: tailnet.url!, local: true };

  it('starts the relay on this computer, then enables on the address it is on', async () => {
    const start = vi.fn(async () => ({ ...tailnet, running: true, enabled: true }));
    await expect(relayToEnable(fallback.url, fallback, tailnet, start)).resolves.toMatchObject({ url: 'ws://gomi.tailfd6474.ts.net:4400' });
    expect(start).toHaveBeenCalledOnce();
  });

  it('says why instead of enabling when the relay cannot start', async () => {
    const start = vi.fn(async () => ({ ...tailnet, enabled: true, error: 'Port 4400 is already in use on this computer.' }));
    const out = await relayToEnable(fallback.url, fallback, tailnet, start);
    expect(out.url).toBeUndefined();
    expect(out.problem).toMatch(/Port 4400 is already in use/);
  });

  it('does not start anything for a pasted relay, or one already running', async () => {
    const start = vi.fn();
    await expect(relayToEnable('wss://relay.example.com', fallback, tailnet, start)).resolves.toEqual({ url: 'wss://relay.example.com' });
    await expect(relayToEnable(fallback.url, fallback, { ...tailnet, running: true }, start)).resolves.toEqual({ url: fallback.url });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('the card when its relay is the default', () => {
  it('says Remote access will use it instead of offering Use this relay', () => {
    const running = { ...tailnet, running: true, enabled: true };
    const out = renderToStaticMarkup(<LocalRelayView relay={running} onToggle={vi.fn()} onUse={vi.fn()} inUse={running.url} />);
    expect(out).toContain('Remote access will use this relay.');
    expect(out).not.toContain('Use this relay<');
  });
});
