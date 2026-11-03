import { describe, expect, it, vi } from 'vitest';
import type { ComputerStatus } from '@nekko-agent/shared';
import { computerDetail, computerLink } from './ComputersSection.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

const gomi: ComputerStatus = { id: 'ab12cd34', name: 'gomi', platform: 'win32', relayUrl: 'ws://100.100.1.1:4400', alts: [], pairedAt: 1, color: 0, state: 'online', route: 'ws://100.100.1.1:4400', read: true, change: true };

const api = (enabled: boolean) => ({
  getRemoteStatus: vi.fn(async () => ({ enabled })),
  getRemotePairing: vi.fn(async () => ({ relayUrl: 'ws://100.100.1.2:4400', room: 'a1b2c3d4e5f60718', key: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' })),
  startComputerPairing: vi.fn(async () => ({ code: 'QWER2345', expiresAt: 1 })),
  localRelayStatus: vi.fn(async () => { throw new Error('no relay'); }),
}) as unknown as Parameters<typeof computerLink>[0] & { startComputerPairing: ReturnType<typeof vi.fn> };

describe('Settings > Computers', () => {
  it('says how a computer is reached', () => {
    expect(computerDetail(gomi)).toBe('Connected over Tailscale');
    expect(computerDetail({ ...gomi, route: 'ws://192.168.1.20:4400' })).toBe('Connected on this network');
    expect(computerDetail({ ...gomi, route: 'wss://relay.example' })).toBe('Connected over the relay');
  });

  it('says when a computer only allows watching', () => {
    expect(computerDetail({ ...gomi, change: false })).toBe('Connected over Tailscale. gomi allows watching only.');
  });

  it('names what to do when a computer cannot be reached', () => {
    expect(computerDetail({ ...gomi, state: 'offline' })).toBe('Offline');
    expect(computerDetail({ ...gomi, state: 'update' })).toBe('Needs an update');
    expect(computerDetail({ ...gomi, state: 'denied' })).toContain('Connect it again');
  });

  it('makes a link carrying a computer code', async () => {
    const made = await computerLink(api(true));
    expect('link' in made && made.link).toContain('pair=QWER2345');
  });

  it('says to set up pairing first when remote access is off, and mints nothing', async () => {
    const off = api(false);
    expect(await computerLink(off)).toEqual({ note: expect.stringContaining('Set up Phone pairing first') });
    expect(off.startComputerPairing).not.toHaveBeenCalled();
  });
});
