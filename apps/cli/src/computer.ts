import { pairingLink, type PairingGrant, type RemoteDevice, type RemotePairing, type RemoteStatus } from '@nekko-agent/shared';

/**
 * A computer with no window (rented compute, a Mac Studio nobody is logged in
 * to): `nekko-agent computer serve` keeps it reachable, and prints what Settings >
 * Computers takes on the desktop that will drive it. The same engine, gate and
 * device registry run as behind the desktop app. A pairing code lives in the
 * running engine, so a new link is a restart of `serve`, not a command beside it.
 */

export interface ComputerClient {
  remoteStatus(): Promise<RemoteStatus>;
  enableRemote(relayUrl: string): Promise<RemoteStatus>;
  remotePairing(): Promise<RemotePairing | null>;
  computerCode(): Promise<PairingGrant>;
  remoteDevices(): Promise<RemoteDevice[]>;
  revokeDevice(id: string): Promise<RemoteDevice[]>;
}

export const COMPUTER_USAGE = 'Usage: nekko-agent computer serve --relay <wss://…>|list|revoke <device>';

/** A one-time link for Settings > Computers, or why there can't be one. */
export async function computerLink(client: ComputerClient): Promise<string> {
  const pairing = await client.remotePairing();
  if (!pairing) throw new Error('Remote access is off. Run: nekko-agent computer serve --relay <wss://…>');
  const grant = await client.computerCode();
  return pairingLink('nekko-agent-pair:', { ...pairing, pair: grant.code });
}

/** Turn remote access on if it isn't, and return the link to pair with. */
export async function serveComputer(client: ComputerClient, relay: string | undefined): Promise<string> {
  const status = await client.remoteStatus();
  if (!status.enabled) {
    if (!relay) throw new Error('Remote access is off, so this computer needs a relay. Pass --relay <wss://…>.');
    await client.enableRemote(relay);
  }
  return computerLink(client);
}

/** The computers and phones paired here. */
export async function pairedDevices(client: ComputerClient): Promise<RemoteDevice[]> {
  return (await client.remoteDevices()).filter((d) => !d.revoked);
}
