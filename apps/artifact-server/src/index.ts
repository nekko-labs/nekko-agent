import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildArtifactServer, DEFAULT_LIMITS, tokenEntry, type Limits } from './server.js';
import { DiskStorage } from './storage.js';

export { artifactPolicy, buildArtifactServer, DEFAULT_LIMITS, randomId, tokenEntry } from './server.js';
export type { ArtifactServerOptions, Limits, TokenEntry } from './server.js';
export { DiskStorage, MemoryStorage, type Storage } from './storage.js';

/** Shortest owner token accepted: a guessable token would let anyone publish. */
const MIN_TOKEN = 32;

/** The configuration from `NEKKO_ARTIFACTS_*`, or the reason it can't start. */
export function configFromEnv(env: NodeJS.ProcessEnv) {
  const token = env.NEKKO_ARTIFACTS_TOKEN ?? '';
  if (token.length < MIN_TOKEN) {
    throw new Error(`Set NEKKO_ARTIFACTS_TOKEN to a random secret of at least ${MIN_TOKEN} characters (for example: openssl rand -hex 32).`);
  }
  const limits: Limits = {
    maxArtifacts: count(env.NEKKO_ARTIFACTS_MAX_ARTIFACTS, DEFAULT_LIMITS.maxArtifacts, 'NEKKO_ARTIFACTS_MAX_ARTIFACTS'),
    maxArtifactBytes: count(env.NEKKO_ARTIFACTS_MAX_MB, DEFAULT_LIMITS.maxArtifactBytes / (1024 * 1024), 'NEKKO_ARTIFACTS_MAX_MB') * 1024 * 1024,
    maxFiles: count(env.NEKKO_ARTIFACTS_MAX_FILES, DEFAULT_LIMITS.maxFiles, 'NEKKO_ARTIFACTS_MAX_FILES'),
    keepVersions: count(env.NEKKO_ARTIFACTS_KEEP_VERSIONS, DEFAULT_LIMITS.keepVersions, 'NEKKO_ARTIFACTS_KEEP_VERSIONS'),
  };
  const apiPort = count(env.NEKKO_ARTIFACTS_API_PORT, 4500, 'NEKKO_ARTIFACTS_API_PORT');
  const contentPort = count(env.NEKKO_ARTIFACTS_CONTENT_PORT, 4501, 'NEKKO_ARTIFACTS_CONTENT_PORT');
  const publicUrl = env.NEKKO_ARTIFACTS_PUBLIC_URL || `http://localhost:${contentPort}`;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(`NEKKO_ARTIFACTS_PUBLIC_URL is not a URL: ${publicUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('NEKKO_ARTIFACTS_PUBLIC_URL must be http:// or https://.');
  if (parsed.search || parsed.hash) throw new Error('NEKKO_ARTIFACTS_PUBLIC_URL must not have a query or a fragment.');
  return {
    host: env.NEKKO_ARTIFACTS_HOST || '0.0.0.0',
    apiPort,
    contentPort,
    publicUrl,
    dataDir: resolve(env.NEKKO_ARTIFACTS_DATA || './data'),
    token,
    limits,
  };
}

function count(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0, not "${raw}".`);
  return n;
}

async function main() {
  const config = configFromEnv(process.env);
  const { api, content } = buildArtifactServer({
    storage: new DiskStorage(config.dataDir),
    tokens: [tokenEntry('owner', config.token, config.limits)],
    publicUrl: config.publicUrl,
  });
  await api.listen({ port: config.apiPort, host: config.host });
  await content.listen({ port: config.contentPort, host: config.host });
  console.log(`Nekko Artifacts server`);
  console.log(`  upload API:  http://${config.host}:${config.apiPort}/v1/artifacts`);
  console.log(`  published at ${config.publicUrl} (served on port ${config.contentPort})`);
  console.log(`  storage:     ${config.dataDir}`);
  console.log(`  limits:      ${config.limits.maxArtifacts} artifacts, ${config.limits.maxArtifactBytes / (1024 * 1024)} MB and ${config.limits.maxFiles} files each, ${config.limits.keepVersions} versions kept`);
}

// Run only as the entrypoint; tests import buildArtifactServer instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
