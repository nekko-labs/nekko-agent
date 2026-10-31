import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { defaultUserDataDir, prepareUserDataRoot } from '@nekko-agent/profile/user-data';
import { brandEnv, unsupportedPlatformReason } from '@nekko-agent/shared';
import { parseCloudScope, runRelayAgent } from './relay-agent.js';
import { runCli } from 'nekko-agent/run';
import { isLoopbackHost, tokenMatches, validateBindSecurity } from './security.js';
import { createApiSecurityHook, isOriginForm, type RequestSecurityOptions } from './request-security.js';
import { registerWebhookRoutes, type WebhookTarget } from './webhooks.js';
import { githubReviewConfig, registerGitHubReviewRoutes, ReviewReplayLedger, type RepositoryReviewInput, type RepositoryReviewVerdict } from './github-review.js';
import { startNekkod } from 'nekko-agent/engine';
import { forwardCall, isSocketRoute, proxyUpgrade, refuse, upgradeAllowed, upstreamPath } from './proxy.js';

/** Subcommands handled by the embedded CLI (so `npx nekko-agent mcp|chat|…` works). */
const CLI_SUBCOMMANDS = new Set([
  'mcp', 'chat', 'status', 'sessions', 'watch', 'workspace', 'prompts', 'tasks',
  'skills', 'tools', 'models', 'train', 'help', 'version',
]);

const SCRIPT = fileURLToPath(import.meta.url);
const __dirname = dirname(SCRIPT);

/** NEKKO_* env. See `brandEnv`. */
const env = brandEnv;

const PORT = Number(env('PORT') ?? 1440);
const HOST = env('HOST') ?? '127.0.0.1';
const isLocal = isLoopbackHost(HOST);
const DATA_DIR = env('DATA_DIR') ?? defaultUserDataDir();
const TOKEN = env('TOKEN') ?? '';
const ALLOW_UNAUTHENTICATED = env('ALLOW_UNAUTHENTICATED') === '1';
const ALLOWED_HOSTS = (env('ALLOWED_HOSTS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (env('ALLOWED_ORIGINS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const requireAuth = TOKEN !== '';

// Find the built renderer: explicit override, then the bundled `web/` (published
// npx package), then the in-repo desktop build (dev).
function findRendererDir(): string {
  const candidates = [
    env('RENDERER_DIR'),
    resolve(__dirname, 'web'),
    resolve(__dirname, '../../desktop/out/renderer'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, 'index.html'))) ?? candidates[candidates.length - 1];
}
const RENDERER_DIR = findRendererDir();

async function main() {
  // Subcommand → embedded CLI (e.g. `npx nekko-agent mcp`, `nekko-agent status`).
  const sub = process.argv[2];
  if (sub && CLI_SUBCOMMANDS.has(sub)) {
    await runCli(process.argv.slice(2));
    return;
  }
  // Intel Macs were dropped (no engine daemon for them): refuse before
  // anything starts. CLI subcommands above still reach a remote app (--url).
  const unsupported = unsupportedPlatformReason(process.platform, process.arch);
  if (unsupported) throw new Error(unsupported);
  prepareUserDataRoot();

  // Relay-agent mode: connect out to a relay instead of serving HTTP locally.
  const relayUrl = env('RELAY_URL');
  const relayRoom = env('ROOM');
  if (relayUrl && relayRoom) {
    await runRelayAgent({
      relayUrl,
      room: relayRoom,
      key: env('PAIR_KEY') || randomUUID().slice(0, 8),
      dataDir: DATA_DIR,
      here: __dirname,
      // A Nekko Cloud machine: its pairing code was minted by Nekko Cloud, and its scope says what it may see.
      pairCode: env('PAIR_CODE') || undefined,
      scope: parseCloudScope(env('CLOUD_SCOPE')),
    });
    return;
  }

  if (!existsSync(join(RENDERER_DIR, 'index.html'))) {
    console.error(
      `[nekko-agent] Renderer not found at ${RENDERER_DIR}.\n` +
        `Build it first (npm run build -w @nekko-agent/desktop) or set NEKKO_RENDERER_DIR.`,
    );
    process.exit(1);
  }
  validateBindSecurity(HOST, TOKEN, ALLOW_UNAUTHENTICATED);

  // Report this build's version (for the Local Web UI's refresh-when-updated check).
  if (env('VERSION') === undefined) {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      // dist/index.js in the repo (../package.json), index.mjs in the npm bundle (./package.json).
      const ours = (p: string) => {
        try {
          const pkg = require(p) as { name?: string; version?: string };
          return pkg.name === '@nekko-agent/local-web-ui' || pkg.name === 'nekko-agent-local-web-ui' ? pkg.version : undefined;
        } catch {
          return undefined;
        }
      };
      process.env.NEKKO_VERSION = ours('../package.json') ?? ours('./package.json') ?? '0.0.0';
    } catch {
      /* leave unset → host reports 0.0.0 */
    }
  }

  const engine = await startNekkod({ here: __dirname, dataDir: DATA_DIR });
  const daemon = engine.daemon;
  const security: RequestSecurityOptions = {
    host: HOST,
    port: PORT,
    token: TOKEN,
    allowedHosts: ALLOWED_HOSTS,
    allowedOrigins: ALLOWED_ORIGINS,
  };

  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
  app.addHook('onRequest', createApiSecurityHook(security));

  // Outside /api, so a container health check needs no token. Says nothing private.
  app.get('/health', async () => ({ ok: true, engine: 'nekkod', daemon: { ready: daemon.ready, restarts: daemon.restarts } }));

  // The engine is nekkod: forward calls, splice sockets.
  const call = async (channel: string, args: unknown[]) => {
    const up = await daemon.endpoint();
    const res = await forwardCall(up, channel, JSON.stringify({ args }));
    const body = res.body ? JSON.parse(res.body) : null;
    if (res.status >= 400) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
    return body;
  };
  const webhookTarget: WebhookTarget = {
    dispatchWebhook: async (slug, secret, payload) => {
      try {
        return { length: ((await call('workflow:webhook', [slug, secret, payload])) as unknown[]).length };
      } catch (e) {
        if ((e as Error).message === 'unauthorized') throw Object.assign(e as Error, { code: 'WEBHOOK_UNAUTHORIZED' });
        throw e;
      }
    },
  };
  // The GitHub review: one tool-free model call in nekkod (repository_review.rs).
  const reviewRepository = (input: RepositoryReviewInput) => call('repository:review', [input]) as Promise<RepositoryReviewVerdict>;
  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/:channel', async (req, reply) => {
    const channel = req.params.channel;
    let up;
    try {
      up = await daemon.endpoint();
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
    try {
      const args = Array.isArray(req.body?.args) ? req.body.args : [];
      const res = await forwardCall(up, channel, JSON.stringify({ args }));
      reply.code(res.status).header('content-type', 'application/json; charset=utf-8').send(res.body || 'null');
    } catch {
      reply.code(502).send({ error: `${channel}: the engine restarted before it answered` });
    }
  });
  app.server.on('upgrade', (req, socket, head: Buffer) => {
    if (!isOriginForm(req.url)) return refuse(socket, 400, 'Bad Request');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }
    if (!isSocketRoute(url.pathname)) return refuse(socket, 404, 'Not Found');
    const verdict = upgradeAllowed(req, url, security);
    if (!verdict.ok) return refuse(socket, verdict.status, verdict.reason);
    daemon.endpoint().then(
      (up) => proxyUpgrade(req, socket, head, up, upstreamPath(url)),
      () => refuse(socket, 503, 'Service Unavailable'),
    );
  });

  // Inbound workflow webhook endpoint: per-trigger secret auth, 10 MB body cap, rate limit.
  registerWebhookRoutes(app, webhookTarget);
  const githubConfig = githubReviewConfig(env);
  if (githubConfig) registerGitHubReviewRoutes(app, githubConfig, reviewRepository, new ReviewReplayLedger(DATA_DIR));

  // Serve the built renderer (same UI as the desktop app).
  await app.register(fastifyStatic, { root: RENDERER_DIR, prefix: '/' });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch {
      /* closing anyway */
    }
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (e) {
    await daemon.stop();
    throw e;
  }
  const url = `http://${isLocal ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nNekko Agent Local Web UI running at ${url}`);
  console.log(`   data dir: ${DATA_DIR}`);
  console.log(`   engine: nekkod (${engine.found.source}: ${engine.found.path})`);
  if (requireAuth) console.log(`   auth: token required (use Authorization: Bearer <token>; browser URLs may use ?token=… for WebSocket access)`);
  else if (!isLocal) console.log(`   ⚠ unauthenticated mode explicitly enabled; ensure an external auth layer protects this service.`);
  console.log(`   (offline-first, only reaches the model servers + connectors you configure)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
