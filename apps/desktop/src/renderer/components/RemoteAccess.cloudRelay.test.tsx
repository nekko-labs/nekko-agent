import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_RELAY_URL, type CloudStatus } from '@nekko-agent/shared';
import { cloudAvailability, cloudRelayOffer, ConnectThroughView, currentPicks, DeviceRoutePicks, pairingRoutes, picksOf, routeOf, routeTargets } from './RemoteAccess.js';

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

describe('routeTargets', () => {
  it('makes Tailscale the main relay when it is ticked, Nekko Cloud Relay the extra one', () => {
    expect(routeTargets({ tailscale: true, cloud: true }, TAILNET)).toEqual({ main: TAILNET, also: [CLOUD_RELAY_URL] });
    expect(routeTargets({ tailscale: true, cloud: false }, TAILNET, [CLOUD_RELAY_URL])).toEqual({ main: TAILNET, also: [] });
  });

  it('moves the room to Nekko Cloud Relay alone, keeping a relay of the owner\'s own', () => {
    expect(routeTargets({ tailscale: false, cloud: true }, TAILNET, [CLOUD_RELAY_URL, 'wss://relay.example.com'])).toEqual({ main: CLOUD_RELAY_URL, also: ['wss://relay.example.com'] });
  });

  it('can\'t tick Tailscale without a tailnet here', () => {
    expect(routeTargets({ tailscale: true, cloud: true }, undefined)).toBeNull();
  });
});

describe('device route ticks', () => {
  it('maps both ticks to either way and one tick to that route', () => {
    expect(routeOf({ tailscale: true, cloud: true })).toBe('auto');
    expect(routeOf({ tailscale: false, cloud: true })).toBe('cloud');
    expect(routeOf({ tailscale: true, cloud: false })).toBe('direct');
    for (const r of ['auto', 'cloud', 'direct'] as const) expect(routeOf(picksOf(r))).toBe(r);
    expect(picksOf(undefined)).toEqual({ tailscale: true, cloud: true });
  });

  it('shows both ways and keeps the last tick on', () => {
    const out = renderToStaticMarkup(<DeviceRoutePicks label="How iPhone connects" value="cloud" onChange={vi.fn()} />);
    expect(out).toContain('Connects through');
    expect(out).toMatch(/role="checkbox" aria-checked="false"[^>]*>.*?Tailscale/);
    expect(out).toMatch(/role="checkbox" aria-checked="true" aria-disabled="true"[^>]*>.*?Nekko Cloud Relay/);
  });
});

describe('currentPicks', () => {
  const local = { available: true, running: true, enabled: true, port: 4400, tailnetIp: '100.1.2.3', tailnetName: 'gomi.tailfd6474.ts.net', url: TAILNET };
  it('reads the ticks from the main relay and the extra ones', () => {
    expect(currentPicks({ enabled: true, relayUrl: TAILNET, alsoRelays: [CLOUD_RELAY_URL] }, local)).toEqual({ tailscale: true, cloud: true });
    expect(currentPicks({ enabled: true, relayUrl: CLOUD_RELAY_URL }, local)).toEqual({ tailscale: false, cloud: true });
    expect(currentPicks({ enabled: false, relayUrl: TAILNET }, local)).toEqual({ tailscale: false, cloud: false });
  });

  it('knows a tailnet relay before this computer\'s relay status loads', () => {
    expect(currentPicks({ enabled: true, relayUrl: TAILNET }, null).tailscale).toBe(true);
  });
});

describe('ConnectThroughView', () => {
  const local = { available: true, running: false, enabled: false, port: 4400, tailnetIp: '100.1.2.3', tailnetName: 'gomi.tailfd6474.ts.net', url: TAILNET };
  const html = (cloud: 'live' | 'upgrade' | 'soon', picks = { tailscale: true, cloud: false }, live?: Parameters<typeof ConnectThroughView>[0]['live']) =>
    renderToStaticMarkup(<ConnectThroughView local={local} picks={picks} cloud={cloud} live={live} onChange={vi.fn()} onUpgrade={vi.fn()} />);

  it('offers both ways as ticks, never naming the relay host', () => {
    const out = html('live');
    expect(out).toContain('Phones connect through');
    expect(out).toMatch(/role="checkbox" aria-checked="true" aria-label="Tailscale"/);
    expect(out).toMatch(/role="checkbox" aria-checked="false" aria-label="Nekko Cloud Relay"/);
    expect(out).not.toContain('fly.dev');
  });

  it('offers Free the upgrade instead of a tick', () => {
    const out = html('upgrade');
    expect(out).toContain('Upgrade to Pro');
    expect(out).toMatch(/aria-label="Nekko Cloud Relay" disabled=""/);
  });

  it('says Nekko Cloud Relay is coming soon until it runs', () => {
    expect(html('soon')).toContain('Coming soon');
  });

  it('keeps the last tick on once remote access is on, and says why a route is down', () => {
    const out = html('live', { tailscale: false, cloud: true }, { cloud: { online: false, error: 'Sign in to Nekko Cloud again to use Nekko Cloud Relay.' } });
    expect(out).toMatch(/aria-label="Nekko Cloud Relay" disabled=""/);
    expect(out).toContain('At least one way stays on');
    expect(out).toContain('Sign in to Nekko Cloud again');
  });

  it('leaves Tailscale out where this computer can\'t run a relay', () => {
    const out = renderToStaticMarkup(<ConnectThroughView local={null} picks={{ tailscale: false, cloud: true }} cloud="live" onChange={vi.fn()} onUpgrade={vi.fn()} />);
    expect(out).not.toContain('aria-label="Tailscale"');
  });
});

describe('cloudAvailability', () => {
  it('is live on the perk, an upgrade on Free, and coming soon while hidden', () => {
    expect(cloudAvailability('included')).toBe('live');
    expect(cloudAvailability('upgrade')).toBe('upgrade');
    expect(cloudAvailability('hidden', false)).toBe('soon');
    expect(cloudAvailability('hidden', true)).toBe('live');
  });
});
