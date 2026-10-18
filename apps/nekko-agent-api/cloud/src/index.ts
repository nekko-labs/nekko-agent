import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { brandEnv } from '@nekko-agent/shared';
import { defaultUserDataDir } from '@nekko-agent/host';
import { createCloudServer } from './server.js';
import { createBilling } from './billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CLOUD_PORT ?? 4318);
const HOST = process.env.CLOUD_HOST ?? '127.0.0.1';
const isLocal = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const DATA_ROOT =
  process.env.CLOUD_DATA_DIR ?? join(defaultUserDataDir(), 'cloud');

// Reuse the desktop-built renderer (same UI as every edition).
function findRendererDir(): string | undefined {
  const candidates = [
    brandEnv('RENDERER_DIR'),
    resolve(__dirname, 'web'),
    resolve(__dirname, '../../../desktop/out/renderer'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, 'index.html')));
}

async function main() {
  if (!process.env.CLOUD_DATA_DIR && existsSync(join(homedir(), '.nekko-cloud', 'cloud.json')) && !existsSync(join(DATA_ROOT, 'cloud.json'))) throw new Error('An existing cloud profile is in ~/.nekko-cloud. Stop the deployment and move it to ~/.nekko-agent/cloud, or set CLOUD_DATA_DIR explicitly. Existing cloud accounts are never replaced with an empty deployment.');
  const billing = createBilling();
  const { app } = createCloudServer({ dataRoot: DATA_ROOT, rendererDir: findRendererDir(), billing });
  await app.listen({ port: PORT, host: HOST });
  const url = `http://${isLocal ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nNekko Cloud running at ${url}`);
  console.log(`   data root: ${DATA_ROOT}`);
  console.log(`   accounts: sign up / log in at the URL above (per-account isolated data + plan entitlements)`);
  console.log(
    billing.enabled
      ? `   billing: Stripe enabled (plans: ${billing.availablePlans().join(', ') || 'none priced'})\n`
      : `   billing: disabled (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO/TEAM + STRIPE_WEBHOOK_SECRET to enable)\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
