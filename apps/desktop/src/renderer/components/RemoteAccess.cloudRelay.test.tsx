import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_RELAY_URL, type CloudStatus } from '@nekko-agent/shared';
import { cloudRelayOffer, CloudRelayRow, PairingChoiceView, pairingRoutes, RouteChoice } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

// Decision 0116: Nekko Cloud Relay is a Pro perk, beside Tailscale, chosen per device.

const TAILNET = 'ws://gomi.tailfd6474.ts.net:4400';
const LAN = 'ws://192.168.1.20:4400';

const cloud = (account: Partial<NonNullable<CloudStatus['account']>> | null, signedIn = true) =>
  ({ signedIn, account: account && { email: 'a@b.c', plan: 'free', canSync: false, ...account } }) as CloudStatus;

describe('cloudRelayOffer', () => {
  it('hides it until the switch shows it to this account', () => {
    expect(cloudRelayOffer(null)).toBe('hidden');
    expect(cloudRelayOffer(cloud(null, false))).toBe('hidden');
    expect(cloudRelayOffer(cloud({ plan: 'pro' }))).toBe('hidden');
    expect(cloudRelayOffer(cloud({ plan: 'pro', features: { cloudRelay: true } }, false))).toBe('hidden');
  });

  it('is included on Pro, Team and for the Nekko team, and an upgrade on Free', () => {
    expect(cloudRelayOffer(cloud({ plan: 'pro', features: { cloudRelay: true } }))).toBe('included');
    expect(cloudRelayOffer(cloud({ plan: 'team', features: { cloudRelay: true } }))).toBe('included');
    expect(cloudRelayOffer(cloud({ plan: 'free', staff: true, features: { cloudRelay: true } }))).toBe('included');
    expect(cloudRelayOffer(cloud({ plan: 'free', features: { cloudRelay: true } }))).toBe('upgrade');
  });
});

describe('pairingRoutes', () => {
  it('sends a device that may use either way nearest first, Nekko Cloud Relay last', () => {
    expect(pairingRoutes(TAILNET, [CLOUD_RELAY_URL], [LAN], 'auto')).toEqual({ relayUrl: TAILNET, alts: [LAN, CLOUD_RELAY_URL] });
  });

  it('sends a device limited to one route only there', () => {
    expect(pairingRoutes(TAILNET, [CLOUD_RELAY_URL], [LAN], 'cloud')).toEqual({ relayUrl: CLOUD_RELAY_URL, alts: [] });
    expect(pairingRoutes(TAILNET, [CLOUD_RELAY_URL], [LAN], 'direct')).toEqual({ relayUrl: TAILNET, alts: [LAN] });
  });

  it('is the old link with one relay', () => {
    expect(pairingRoutes(TAILNET, [], [LAN], 'auto')).toEqual({ relayUrl: TAILNET, alts: [LAN] });
    expect(pairingRoutes(CLOUD_RELAY_URL, [], [], 'auto')).toEqual({ relayUrl: CLOUD_RELAY_URL, alts: [] });
  });
});

describe('CloudRelayRow', () => {
  it('is a switch on Pro', () => {
    const out = renderToStaticMarkup(<CloudRelayRow offer="included" on={false} onToggle={vi.fn()} onUpgrade={vi.fn()} />);
    expect(out).toContain('Also through Nekko Cloud Relay');
    expect(out).toContain('role="switch"');
    expect(out).not.toContain('Upgrade to Pro');
    expect(out).not.toContain('fly.dev');
  });

  it('is an upgrade on Free', () => {
    const out = renderToStaticMarkup(<CloudRelayRow offer="upgrade" on={false} onToggle={vi.fn()} onUpgrade={vi.fn()} />);
    expect(out).toContain('Upgrade to Pro');
    expect(out).not.toContain('role="switch"');
  });

  it('says why the route is down', () => {
    const out = renderToStaticMarkup(<CloudRelayRow offer="included" on route={{ online: false, error: 'Sign in to Nekko Cloud again to use Nekko Cloud Relay.' }} onToggle={vi.fn()} onUpgrade={vi.fn()} />);
    expect(out).toContain('Sign in to Nekko Cloud again');
  });
});

describe('PairingChoiceView with the perk', () => {
  const html = (cloudOffer: 'included' | 'upgrade') =>
    renderToStaticMarkup(<PairingChoiceView local={null} relayUrl="" onRelayUrl={vi.fn()} onTailscale={vi.fn()} onCloud={vi.fn()} onOwnRelay={vi.fn()} cloudLive cloudOffer={cloudOffer} onUpgrade={vi.fn()} />);

  it('offers Free the upgrade instead of a connection', () => {
    expect(html('upgrade')).toContain('Upgrade to Pro');
    expect(html('upgrade')).not.toContain('Use Nekko Cloud');
  });

  it('lets Pro connect', () => {
    expect(html('included')).toContain('Use Nekko Cloud');
    expect(html('included')).not.toContain('Upgrade to Pro');
  });
});

describe('RouteChoice', () => {
  it('names the three choices in the owner’s words', () => {
    const out = renderToStaticMarkup(<RouteChoice label="The next device connects through" value="cloud" onChange={vi.fn()} />);
    expect(out).toContain('Either way');
    expect(out).toContain('Nekko Cloud Relay');
    expect(out).toContain('Tailscale');
    expect(out).toMatch(/aria-checked="true"[^>]*>Nekko Cloud Relay/);
  });
});
