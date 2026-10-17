import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createHost, createDispatcher, defaultUserDataDir, flushAgentLogs, prepareUserDataRoot } from '@nekko-agent/host';
import { brandEnv, unsupportedPlatformReason } from '@nekko-agent/shared';
import { runRelayAgent } from './relay-agent.js';
import { runCli } from 'nekko-agent/run';
import { isLoopbackHost, tokenMatches, validateBindSecurity } from './security.js';
import { createApiSecurityHook, type RequestSecurityOptions } from './request-security.js';
import { registerWebhookRoutes, type WebhookTarget } from './webhooks.js';
import { reviewRepository } from '@nekko-agent/host';
import { githubReviewConfig, registerGitHubReviewRoutes, ReviewReplayLedger } from './github-review.js';
import { runBackend } from './backend.js';
import { backendCommand, DaemonProcess, daemonMode, findNekkod, type FoundDaemon } from './nekkod.js';
import { forwardCall, isSocketRoute, proxyUpgrade, refuse, upgradeAllowed, upstreamPath } from './proxy.js';
import { overrideFor, subscribeHostEvents, webChannelOverrides, WEBHOOK_DISPATCH, type WebhookDispatchResult } from './web-channels.js';

/** Subcommands handled by the embedded CLI (so `npx nekko-agent mcp|chat|…` works). */
const CLI_SUBCOMMANDS = new Set([
  'mcp', 'chat', 'status', 'sessions', 'watch', 'workspace', 'prompts', 'tasks',
  'skills', 'tools', 'models', 'train', 'help', 'version',
]);

/** Argument nekkod starts this script with to run it as the TS host backend. */
const BACKEND_FLAG = '--nekko-backend';
/** Answered by this server itself: what the page may expect of the transport. */
const CAPABILITIES_CHANNEL = 'web:capabilities';

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

/** Start nekkod and wait for it, or say why the engine runs in this process instead. */
async function startDaemon(): Promise<{ daemon: DaemonProcess; found: FoundDaemon } | null> {
  const mode = daemonMode(env('DAEMON'));
  if (mode === 'ts') {
    console.log('[nekko-agent] NEKKO_DAEMON=ts: running the engine in this process (TS terminals).');
    return null;
  }
  const found = findNekkod({ here: __dirname });
  if (!found) {
    const override = process.env.NEKKOD_PATH;
    const message = override
      ? `nekkod (the engine daemon) was not found: NEKKOD_PATH points at ${override}, which does not exist.`
      : 'nekkod (the engine daemon) was not found: no NEKKOD_PATH, no @nekko-agent/nekkod-' +
        `${process.platform}-${process.arch} package, no bin/ beside this script and no cargo build.`;
    if (mode === 'nekkod') throw new Error(`${message} NEKKO_DAEMON=nekkod requires it.`);
    console.warn(`[nekko-agent] ${message} Running the engine in this process instead (TS terminals).`);
    return null;
  }
  const daemon = new DaemonProcess({
    exe: found.path,
    dataDir: DATA_DIR,
    backend: backendCommand(SCRIPT, { NEKKO_DATA_DIR: DATA_DIR }),
  });
  daemon.start();
  try {
    await daemon.endpoint(20_000);
    return { daemon, found };
  } catch (e) {
    await daemon.stop();
    if (mode === 'nekkod') throw new Error(`nekkod at ${found.path} did not start: ${(e as Error).message}`);
    console.warn(`[nekko-agent] nekkod at ${found.path} did not start (${(e as Error).message}); running the engine in this process instead.`);
    return null;
  }
}

async function main() {
  // Subcommand → embedded CLI (e.g. `npx nekko-agent mcp`, `nekko-agent status`).
  const sub = process.argv[2];
  if (sub && CLI_SUBCOMMANDS.has(sub)) {
    await runCli(process.argv.slice(2));
    return;
  }
  // Started by nekkod as its TS host backend.
  if (process.argv.includes(BACKEND_FLAG)) {
    await runBackend(DATA_DIR);
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

  // Report this build's version (for the web edition's refresh-when-updated check).
  if (env('VERSION') === undefined) {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      // dist/index.js in the repo (../package.json), index.mjs in the npm bundle (./package.json).
      const ours = (p: string) => {
        try {
          const pkg = require(p) as { name?: string; version?: string };
          return pkg.name === '@nekko-agent/server' || pkg.name === 'nekko-agent-web' ? pkg.version : undefined;
        } catch {
          return undefined;
        }
      };
      process.env.NEKKO_VERSION = ours('../package.json') ?? ours('./package.json') ?? '0.0.0';
    } catch {
      /* leave unset → host reports 0.0.0 */
    }
  }

  const engine = await startDaemon();
  const daemon = engine?.daemon ?? null;
  const security: RequestSecurityOptions = {
    host: HOST,
    port: PORT,
    token: TOKEN,
    allowedHosts: ALLOWED_HOSTS,
    allowedOrigins: ALLOWED_ORIGINS,
  };
  const capabilities = { engine: daemon ? 'nekkod' : 'ts', terminalStream: Boolean(daemon) };

  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
  app.addHook('onRequest', createApiSecurityHook(security));

  // Outside /api, so a container health check needs no token. Says nothing private.
  app.get('/health', async () => ({ ok: true, engine: capabilities.engine, daemon: daemon ? { ready: daemon.ready, restarts: daemon.restarts } : null }));

  let webhookTarget: WebhookTarget;
  if (daemon) {
    // The engine is nekkod: forward calls, splice sockets.
    const call = async (channel: string, args: unknown[]) => {
      const up = await daemon.endpoint();
      const res = await forwardCall(up, channel, JSON.stringify({ args }));
      const body = res.body ? JSON.parse(res.body) : null;
      if (res.status >= 400) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
      return body;
    };
    webhookTarget = {
      dispatchWebhook: async (slug, secret, payload) => {
        const r = (await call(WEBHOOK_DISPATCH, [slug, secret, payload])) as WebhookDispatchResult;
        if ('unauthorized' in r) throw Object.assign(new Error('unauthorized'), { code: 'WEBHOOK_UNAUTHORIZED' });
        return { length: r.started };
      },
    };
    app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/:channel', async (req, reply) => {
      const channel = req.params.channel;
      if (channel === CAPABILITIES_CHANNEL) return reply.send(capabilities);
      if (channel === WEBHOOK_DISPATCH) return reply.code(404).send({ error: 'not found' });
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
  } else {
    // The engine runs in this process.
    await app.register(websocket);
    const host = createHost({ dataDir: DATA_DIR });
    const dispatch = createDispatcher(host);
    const overrides = webChannelOverrides(host);
    webhookTarget = host;
    app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/:channel', async (req, reply) => {
      try {
        const channel = req.params.channel;
        if (channel === CAPABILITIES_CHANNEL) return reply.send(capabilities);
        if (channel === WEBHOOK_DISPATCH) return reply.code(404).send({ error: 'not found' });
        const own = overrideFor(overrides, channel);
        const args = req.body?.args ?? [];
        const result = await (typeof own === 'function' ? own(args) : dispatch(channel, args));
        reply.send(result ?? null);
      } catch (e) {
        reply.code(400).send({ error: (e as Error).message });
      }
    });
    // Stream agent + index events over a WebSocket.
    app.get('/api/events', { websocket: true }, (socket: any, req) => {
      if (requireAuth) {
        const header = req.headers.authorization;
        const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
        const q = (req.query as Record<string, string> | undefined)?.token;
        if (!tokenMatches(TOKEN, bearer ?? q)) {
          socket.close();
          return;
        }
      }
      const off = subscribeHostEvents(host, (frame) => socket.send(frame));
      socket.on('close', off);
    });
  }

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
    if (daemon) await daemon.stop();
    else await flushAgentLogs().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (e) {
    if (daemon) await daemon.stop();
    throw e;
  }
  const url = `http://${isLocal ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nNekko Agent web edition running at ${url}`);
  console.log(`   data dir: ${DATA_DIR}`);
  console.log(engine ? `   engine: nekkod (${engine.found.source}: ${engine.found.path})` : '   engine: in-process TS host');
  if (requireAuth) console.log(`   auth: token required (use Authorization: Bearer <token>; browser URLs may use ?token=… for WebSocket access)`);
  else if (!isLocal) console.log(`   ⚠ unauthenticated mode explicitly enabled; ensure an external auth layer protects this service.`);
  console.log(`   (offline-first, only reaches the model servers + connectors you configure)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
