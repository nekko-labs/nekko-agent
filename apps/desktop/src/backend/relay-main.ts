/**
 * The relay this computer runs for its own phones (Settings → Remote access →
 * Relay on this computer): `apps/relay`, bundled into the app as
 * `out/main/relay.js` and started by `local-relay.ts` with the app's Electron
 * binary under `ELECTRON_RUN_AS_NODE=1`.
 *
 * It listens only on the address it is given (this computer's Tailscale
 * address), so it is reachable from the tailnet and nowhere else. Agent
 * enrollment is open because the only agent that can reach it is this
 * computer; phones still need the room key and a pairing code, and every frame
 * stays end-to-end sealed. No push: a private relay has no APNs or FCM keys.
 *
 * Environment: `NEKKO_RELAY_HOST`, `NEKKO_RELAY_PORT`. Prints
 * `NEKKO_RELAY_READY {"port":N}` once listening; exits when stdin closes, so it
 * never outlives the backend that started it.
 */
import { createPushSender } from '../../../relay/src/push.js';
import { buildRelay } from '../../../relay/src/server.js';

async function main(): Promise<void> {
  const host = process.env.NEKKO_RELAY_HOST;
  const port = Number(process.env.NEKKO_RELAY_PORT ?? 0);
  if (!host) throw new Error('NEKKO_RELAY_HOST is not set');
  // An empty environment: a disabled sender, whatever APNS_* the app inherited.
  const { app } = buildRelay({ allowUnauthenticated: true, pushSender: createPushSender({}) });
  await app.listen({ host, port });
  const address = app.server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`NEKKO_RELAY_READY ${JSON.stringify({ port: bound })}\n`);
  const stop = () => void app.close().finally(() => process.exit(0));
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
