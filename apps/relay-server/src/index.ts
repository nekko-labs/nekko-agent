import { brandEnv } from '@nekko-agent/shared';
import { buildRelay } from './server.js';
import { parseTicketKey } from './ticket.js';

export { buildRelay, controlFrame, DEFAULT_LIMITS } from './server.js';

const PORT = Number(brandEnv('RELAY_PORT') ?? 4400);
const HOST = brandEnv('RELAY_HOST') ?? '0.0.0.0';

async function main() {
  const authzUrl = brandEnv('RELAY_AUTHZ_URL') || undefined;
  const allowUnauthenticated = brandEnv('RELAY_ALLOW_UNAUTHENTICATED') === '1';
  // Nekko Cloud Relay (decision 0116): the public half of the Cloud API's ticket signing key.
  const ticketText = brandEnv('RELAY_TICKET_KEY');
  const ticketKey = ticketText ? parseTicketKey(ticketText) : undefined;
  const { app } = buildRelay({ authzUrl, allowUnauthenticated, ticketKey, presenceSecret: brandEnv('RELAY_PRESENCE_SECRET') || undefined });
  await app.listen({ port: PORT, host: HOST });
  console.log(`\n🐾 Nekko Agent relay listening on ws://${HOST}:${PORT}/relay`);
  console.log(`   access: ${authzUrl ? `gated (agents authorized via ${authzUrl})` : allowUnauthenticated ? 'WARNING: unauthenticated agent enrollment explicitly enabled' : 'agent enrollment disabled (set NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 only for trusted deployments)'}`);
  console.log(`   Nekko Cloud Relay tickets: ${ticketKey ? 'checked (account channel on /account)' : 'off (set NEKKO_RELAY_TICKET_KEY)'}`);
  console.log(`   internal presence (/presence): ${brandEnv('RELAY_PRESENCE_SECRET') ? 'on' : 'off (set NEKKO_RELAY_PRESENCE_SECRET)'}`);
  console.log(`   push: ${process.env.APNS_KEY_P8 || process.env.FCM_SERVICE_ACCOUNT ? 'configured (APNs/FCM)' : 'disabled (set APNS_* and/or FCM_SERVICE_ACCOUNT)'}\n`);
}

// Run only when executed as the entrypoint (tests import buildRelay instead).
const { pathToFileURL } = await import('node:url');
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
