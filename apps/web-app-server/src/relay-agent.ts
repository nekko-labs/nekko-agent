import { createHost } from '@nekko-agent/host';

/**
 * Relay-agent mode for the server CLI: create a host and expose it over a relay
 * via the host's remote-access service (shared with the desktop's in-app
 * "remote access" feature), so headless agents get the same device registry,
 * pairing codes, and revocation. Prints a one-time pairing code at boot; more
 * devices can be paired later from the UI (or by restarting).
 */
export async function runRelayAgent(opts: { relayUrl: string; room: string; key: string; dataDir: string }): Promise<void> {
  const host = createHost({ dataDir: opts.dataDir });
  host.remote.attach({ relayUrl: opts.relayUrl, room: opts.room, secret: opts.key });
  const grant = host.remote.pair();
  console.log(`\nNekko Agent relay-agent → ${opts.relayUrl}`);
  console.log(`   room=${opts.room}  key=${opts.key}`);
  console.log(`   one-time pairing code (10 min): ${grant.code}`);
  console.log(`   pairing link: <ui-origin>/?relay=${encodeURIComponent(opts.relayUrl)}&room=${opts.room}&key=${opts.key}&pair=${grant.code}`);
  console.log(`   serving this machine's model + tools to paired devices (data: ${opts.dataDir})\n`);
}
