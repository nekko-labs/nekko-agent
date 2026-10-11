import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createDispatcher, createHost, flushAgentLogs, useEngineDaemon, useTerminalDaemon } from '@nekko-agent/host';
import { tokenMatches } from './security.js';
import { overrideFor, subscribeHostEvents, webChannelOverrides } from './web-channels.js';

/**
 * The web edition's TS host backend, run by nekkod (`--nekko-backend`).
 *
 * The same contract as the desktop backend (`apps/desktop/src/backend/index.ts`):
 * a loopback wire with `POST /api/:channel` and `/api/events`, guarded by the
 * per-launch `NEKKO_BACKEND_TOKEN`; `NEKKO_BACKEND_READY {"port":N}` on stdout
 * once listening; stdin EOF (nekkod exiting or stopping us) is the shutdown
 * signal. The ptys and model-server processes are nekkod's, reached through
 * `NEKKOD_URL`.
 */
export async function runBackend(dataDir: string): Promise<void> {
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

  const host = createHost({ dataDir });
  const dispatch = createDispatcher(host);
  const overrides = webChannelOverrides(host);
  const run = (channel: string, args: unknown[]) => {
    const own = overrideFor(overrides, channel);
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
    const only = (req.query as Record<string, string> | undefined)?.only;
    const off = subscribeHostEvents(host, (frame) => socket.send(frame), only);
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
