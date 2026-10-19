import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalRelayStatus } from '@nekko-agent/shared';
import { defaultRelay, LocalRelayView, MANAGED_RELAY_URL, relayToEnable } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

// TASKS.md IO-19 TS-1: with Tailscale here and no relay chosen, Remote access
// defaults to the relay on this computer instead of the managed host.
const tailnet: LocalRelayStatus = {
  available: true,
  running: false,
  enabled: false,
  port: 4400,
  tailnetIp: '100.114.173.86',
  tailnetName: 'gomi.tailfd6474.ts.net',
  url: 'ws://gomi.tailfd6474.ts.net:4400',
};

describe('defaultRelay', () => {
  it('is the relay on this computer when Tailscale is connected and no relay is chosen', () => {
    expect(defaultRelay(undefined, tailnet)).toEqual({ url: 'ws://gomi.tailfd6474.ts.net:4400', local: true });
  });

  it('treats a saved managed URL as no choice', () => {
    expect(defaultRelay(MANAGED_RELAY_URL, tailnet)).toEqual({ url: 'ws://gomi.tailfd6474.ts.net:4400', local: true });
  });

  it('keeps a relay the owner chose', () => {
    expect(defaultRelay('wss://relay.example.com', tailnet)).toEqual({ url: 'wss://relay.example.com', local: false });
  });

  it('falls back to the managed relay without Tailscale, before the status loads, and in the web edition', () => {
    const noTailnet: LocalRelayStatus = { available: true, running: false, enabled: false, port: 4400 };
    expect(defaultRelay(undefined, noTailnet)).toEqual({ url: MANAGED_RELAY_URL, local: false });
    expect(defaultRelay(undefined, null)).toEqual({ url: MANAGED_RELAY_URL, local: false });
    expect(defaultRelay(undefined, { ...tailnet, available: false })).toEqual({ url: MANAGED_RELAY_URL, local: false });
  });
});

describe('relayToEnable', () => {
  const fallback = defaultRelay(undefined, tailnet);

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
