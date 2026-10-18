import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  createDispatcher,
  createHost,
  flushAgentLogs,
  settingsSaved,
  isDaemonCopy,
  listAgentTerminals,
  useEngineDaemon,
  useTerminalDaemon,
  type Host,
} from '@nekko-agent/host';
import { IpcEvents } from '@nekko-agent/shared';

/**
 * The TS host backend nekkod runs (`--nekko-backend`), outside the desktop app:
 * the Local Web UI's and the CLI's local engine's.
 *
 * The same contract as the desktop backend (`apps/desktop/src/backend/index.ts`):
 * a loopback wire with `POST /api/:channel` and `/api/events`, guarded by the
 * per-launch `NEKKO_BACKEND_TOKEN`; `NEKKO_BACKEND_READY {"port":N}` on stdout
 * once listening; stdin EOF (nekkod exiting or stopping us) is the shutdown
 * signal. The ptys and model-server processes are nekkod's, reached through
 * `NEKKOD_URL`.
 */

export type ChannelHandler = (args: unknown[]) => unknown;
/** A Map, so a channel named `constructor` or `__proto__` can never reach Object.prototype. */
export type ChannelOverrides = Map<string, ChannelHandler>;

/** What every backend answers beside the shared dispatcher. */
export function baseOverrides(): ChannelOverrides {
  // nekkod merges the terminals it owns with the ones it does not (the agent command logs).
  return new Map<string, ChannelHandler>([['terminals:list:agent', () => listAgentTerminals()]]);
}

/** Every host event, keyed by the host's event name, with the channel clients know it by. */
export const HOST_EVENTS = Object.entries(IpcEvents) as [string, string][];

/**
 * Subscribe `send` to every host event (or `only` that channel); returns the
 * unsubscribe. `forDaemon` leaves out what the daemon already has (`isDaemonCopy`).
 */
export function subscribeHostEvents(host: Host, send: (frame: string) => void, only?: string | null, forDaemon = false): () => void {
  const offs = HOST_EVENTS.filter(([, channel]) => !only || channel === only).map(([name, channel]) => {
    const listener = (payload: unknown) => {
      if (forDaemon && isDaemonCopy(name, payload)) return;
      send(JSON.stringify({ channel, payload }));
    };
    host.events.on(name, listener);
    return () => host.events.off(name, listener);
  });
  return () => offs.forEach((off) => off());
}

function tokenMatches(expected: string, supplied?: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export interface BackendOptions {
  /** Channels this edition answers differently (on top of `baseOverrides`). */
  overrides?: (host: Host) => ChannelOverrides;
  /**
   * Bring the local model server up at start when the settings say so. A
   * one-shot CLI command must not (`NEKKO_BACKEND_AUTOSTART=0`).
   */
  autoStartEngine?: boolean;
}

export async function runBackend(dataDir: string, opts: BackendOptions = {}): Promise<void> {
  const token = process.env.NEKKO_BACKEND_TOKEN;
  if (!token) throw new Error('NEKKO_BACKEND_TOKEN is not set; the backend is started by nekkod, not by hand');
  delete process.env.NEKKO_BACKEND_TOKEN;
  const daemonUrl = process.env.NEKKOD_URL;
  const daemonToken = process.env.NEKKOD_TOKEN;
  delete process.env.NEKKOD_TOKEN;
  if (daemonUrl && daemonToken) {
    useTerminalDaemon({ url: daemonUrl, token: daemonToken });
    useEngineDaemon({ url: daemonUrl, token: daemonToken });
  }

  const autoStartEngine = opts.autoStartEngine ?? process.env.NEKKO_BACKEND_AUTOSTART !== '0';
  const host = createHost({ dataDir, autoStartEngine });
  const dispatch = createDispatcher(host);
  const overrides = baseOverrides();
  for (const [channel, fn] of opts.overrides?.(host) ?? []) overrides.set(channel, fn);
  const run = (channel: string, args: unknown[]) => {
    const own = overrides.get(channel);
    return typeof own === 'function' ? own(args) : dispatch(channel, args);
  };

  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  // Longer than nekkod's pooled-connection idle time, so the daemon always retires a connection first.
  app.server.keepAliveTimeout = 120_000;
  app.server.headersTimeout = 125_000;
  await app.register(websocket);
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const query = (req.query as Record<string, string> | undefined)?.token;
    if (!tokenMatches(token, bearer ?? query)) reply.code(401).send({ error: 'unauthorized' });
  });
  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/:channel', async (req, reply) => {
    try {
      const args = Array.isArray(req.body?.args) ? req.body.args : [];
      reply.send((await run(req.params.channel, args)) ?? null);
    } catch (e) {
      reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get('/api/events', { websocket: true }, (socket: any, req) => {
    const query = req.query as Record<string, string> | undefined;
    const off = subscribeHostEvents(host, (frame) => socket.send(frame), query?.only, query?.forDaemon === '1');
    socket.on('close', off);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;

  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch {
      /* closing anyway */
    }
    // Settings changes still on their way to nekkod (it keeps serving until we exit).
    await Promise.race([settingsSaved(), new Promise((r) => setTimeout(r, 3000))]);
    try {
      await flushAgentLogs();
    } catch (error) {
      console.error('Command log shutdown drain failed:', error);
      code = 1;
    }
    // 'exit' handlers (runtime supervisors, model server children) run here.
    process.exit(code);
  };
  process.stdin.on('end', () => void shutdown(0));
  process.stdin.on('close', () => void shutdown(0));
  process.stdin.resume();
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  process.stdout.write(`NEKKO_BACKEND_READY ${JSON.stringify({ port, pid: process.pid })}\n`);
}
