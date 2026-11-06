import { describe, expect, it, vi } from 'vitest';
import { parsePairingLink } from '@nekko-agent/shared';
import { computerLink, pairedDevices, serveComputer, type ComputerClient } from './computer.js';

const pairing = { relayUrl: 'wss://relay.example', room: 'a1b2c3d4e5f60718', key: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' };

function client(enabled: boolean, over: Partial<ComputerClient> = {}): ComputerClient {
  return {
    remoteStatus: vi.fn(async () => ({ enabled }) as never),
    enableRemote: vi.fn(async () => ({ enabled: true }) as never),
    remotePairing: vi.fn(async () => (enabled ? pairing : null)),
    computerCode: vi.fn(async () => ({ code: 'QWER2345', expiresAt: 1 })),
    remoteDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async () => []),
    ...over,
  };
}

describe('a computer with no window', () => {
  it('prints a link the desktop can pair with', async () => {
    const link = await computerLink(client(true));
    expect(parsePairingLink(link)).toMatchObject({ relayUrl: 'wss://relay.example', pair: 'QWER2345' });
  });

  it('says how to turn it on rather than minting a code', async () => {
    const off = client(false);
    await expect(computerLink(off)).rejects.toThrow('computer serve');
    expect(off.computerCode).not.toHaveBeenCalled();
  });

  it('needs a relay the first time', async () => {
    const off = client(false);
    await expect(serveComputer(off, undefined)).rejects.toThrow('--relay');
    expect(off.enableRemote).not.toHaveBeenCalled();
  });

  it('turns remote access on, then makes a link', async () => {
    const off = client(false, { remotePairing: vi.fn(async () => pairing) });
    expect(await serveComputer(off, 'wss://relay.example')).toContain('pair=QWER2345');
    expect(off.enableRemote).toHaveBeenCalledWith('wss://relay.example');
  });

  it('keeps an existing relay', async () => {
    const on = client(true);
    await serveComputer(on, 'wss://other.example');
    expect(on.enableRemote).not.toHaveBeenCalled();
  });

  it('lists what is paired, without revoked devices', async () => {
    const c = client(true, { remoteDevices: vi.fn(async () => [{ id: 'a' }, { id: 'b', revoked: 1 }] as never) });
    expect((await pairedDevices(c)).map((d) => d.id)).toEqual(['a']);
  });
});
