/**
 * The relay this computer runs for its own phones (Settings → Remote access →
 * Relay on this computer): `apps/relay-server`, bundled into the app as
 * `out/main/relay.js` and started by nekkod (`local_relay.rs`) with the app's Electron
 * binary under `ELECTRON_RUN_AS_NODE=1`.
 *
 * It listens only on the addresses it is given: this computer's Tailscale
 * address and, unless the owner switched it off, its private LAN addresses
 * (RFC 1918 only, see relay-listen.ts), so it is reachable from the tailnet
 * and the local network and nowhere else. Agent enrollment is open because
 * the only agent that can reach it is this computer; phones still need the
 * room key and a pairing code, and every frame stays end-to-end sealed. No
 * push: a private relay has no APNs or FCM keys.
 *
 * Environment: `NEKKO_RELAY_HOST`, `NEKKO_RELAY_PORT`, `NEKKO_RELAY_LAN_HOSTS`
 * (comma-separated). Prints `NEKKO_RELAY_READY {"port":N,"lan":[…]}` once
 * listening, with the LAN addresses it could bind; exits when stdin closes, so
 * it never outlives the daemon that started it.
 */
import { createPushSender } from '../../../relay-server/src/push.js';
import { buildRelay } from '../../../relay-server/src/server.js';
import { lanHostsFromEnv, listenAlso } from './relay-listen.js';

async function main(): Promise<void> {
  const host = process.env.NEKKO_RELAY_HOST;
  const port = Number(process.env.NEKKO_RELAY_PORT ?? 0);
  if (!host) throw new Error('NEKKO_RELAY_HOST is not set');
  // An empty environment: a disabled sender, whatever APNS_* the app inherited.
  const { app } = buildRelay({ allowUnauthenticated: true, pushSender: createPushSender({}) });
  await app.listen({ host, port });
  const address = app.server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  const lan = await listenAlso(app.server, lanHostsFromEnv(process.env.NEKKO_RELAY_LAN_HOSTS), bound);
  process.stdout.write(`NEKKO_RELAY_READY ${JSON.stringify({ port: bound, lan: lan.bound })}\n`);
  const stop = () => {
    for (const s of lan.servers) s.close();
    void app.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  process.stderr.write(`NEKKO_RELAY_ERROR ${JSON.stringify({ code, message: (e as Error)?.message ?? String(e) })}\n`);
  process.exit(1);
});
