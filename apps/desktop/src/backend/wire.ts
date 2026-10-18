import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { URL } from 'node:url';
import { IpcEvents } from '@nekko-agent/shared';
import { createDispatcher, isDaemonCopy, type Host } from '@nekko-agent/host';
import { acceptKey, encodeFrame, FrameReader, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT } from './ws.js';

/**
 * The backend's loopback wire, for `nekkod` (and for the desktop shell when
 * the daemon is unavailable, see `main/engine-process.ts`).
 *
 * The same three routes the daemon serves, with the same shapes:
 * `POST /api/:channel`, `/api/events` (every host event; `?only=` one
 * channel, `?forDaemon=1` none of the copies the daemon already has) and `/api/ws`
 * (requests, replies and events on one socket). A per-launch token guards all
 * of it, and it binds 127.0.0.1 only.
 */

/** Channels the desktop backend answers itself instead of the shared dispatcher. */
export type ChannelOverrides = Record<string, (args: unknown[]) => unknown>;

export interface Wire {
  port: number;
  close(): void;
}

// The same limits as the daemon (crates/nekkod/src/wire.rs): the Local Web UI's
// public 25 MB for every call, and 64 MB for `chat:turn`, whose send options
// carry the user's attached images inline.
const CALL_BODY_LIMIT = 25 * 1024 * 1024;
const TURN_BODY_LIMIT = 64 * 1024 * 1024;

function bodyLimit(channel: string): number {
  return channel === 'chat:turn' ? TURN_BODY_LIMIT : CALL_BODY_LIMIT;
}

/**
 * A DNS-rebound page reaches us under its own host name; refuse it, as the
 * daemon does. A missing Host header passes (HTTP/1.0 clients), the token
 * still guards the call.
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return true;
  const name = host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function tokenMatches(expected: string, got: string | undefined | null): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return url.searchParams.get('token') ?? undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * The body, or `null` once it passes `limit`. Over the limit the rest is
 * discarded as it arrives, so the 413 reaches the client without a reset
 * (leaving the iterator early would destroy the request and the socket).
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    if (over) continue;
    size += (chunk as Buffer).length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  return over ? null : Buffer.concat(chunks).toString('utf8');
}

/** Every host event name, keyed to the channel clients know it by. */
const EVENTS = Object.entries(IpcEvents) as [string, string][];

export function startWire(opts: {
  host: Host;
  token: string;
  overrides: ChannelOverrides;
  /** Origins allowed to open a socket (`null` is a file:// page). */
  origins: string[];
}): Promise<Wire> {
  const { host, token, overrides, origins } = opts;
  const dispatch = createDispatcher(host);
  const run = async (channel: string, args: unknown[]) => {
    const own = overrides[channel];
    return own ? own(args) : dispatch(channel, args);
  };
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!hostIsLoopback(req.headers.host)) return sendJson(res, 403, { error: 'unauthorized' });
      if (!tokenMatches(token, bearerOf(req, url))) return sendJson(res, 401, { error: 'unauthorized' });
      const channel = url.pathname.startsWith('/api/') ? decodeURIComponent(url.pathname.slice(5)) : '';
      if (req.method !== 'POST' || !channel) return sendJson(res, 404, { error: 'not found' });
      const raw = await readBody(req, bodyLimit(channel));
      if (raw === null) return sendJson(res, 413, { error: 'body too large' });
      let args: unknown[] = [];
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (Array.isArray(parsed?.args)) args = parsed.args;
      } catch {
        return sendJson(res, 400, { error: 'body is not JSON' });
      }
      try {
        sendJson(res, 200, (await run(channel, args)) ?? null);
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
      }
    })().catch(() => sendJson(res, 500, { error: 'internal error' }));
  });

  // Node closes an idle keep-alive socket after 5 s by default, and a daemon
  // request sent as it closes fails outright. Keep sockets open longer than the
  // daemon's pool holds them (30 s, `BACKEND_POOL_IDLE` in nekkod) so the
  // daemon always retires a connection first.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    const route = url.pathname;
    if ((route !== '/api/events' && route !== '/api/ws') || typeof key !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if ((origin && !origins.includes(origin)) || !hostIsLoopback(req.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (!tokenMatches(token, bearerOf(req, url))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    sockets.add(socket);

    const send = (text: string) => {
      if (!socket.destroyed) socket.write(encodeFrame(Buffer.from(text, 'utf8'), OP_TEXT));
    };
    const only = url.searchParams.get('only');
    // The daemon's own subscription: none of the copies it already has.
    const forDaemon = url.searchParams.get('forDaemon') === '1';
    const unsubscribe = EVENTS.filter(([, channel]) => !only || channel === only).map(([name, channel]) => {
      const listener = (payload: unknown) => {
        if (forDaemon && isDaemonCopy(name, payload)) return;
        send(JSON.stringify({ channel, payload }));
      };
      host.events.on(name, listener);
      return () => host.events.off(name, listener);
    });

    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      let messages;
      try {
        messages = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const m of messages) {
        if (m.opcode === OP_CLOSE) {
          socket.end(encodeFrame(Buffer.alloc(0), OP_CLOSE));
          return;
        }
        if (m.opcode === OP_PING) {
          socket.write(encodeFrame(m.payload, OP_PONG));
          continue;
        }
        if (route !== '/api/ws' || m.opcode !== OP_TEXT) continue;
        let req: { id?: unknown; channel?: string; args?: unknown[] };
        try {
          req = JSON.parse(m.payload.toString('utf8'));
        } catch {
          continue;
        }
        const id = req.id ?? null;
        void Promise.resolve()
          .then(() => run(String(req.channel ?? ''), Array.isArray(req.args) ? req.args : []))
          .then(
            (result) => send(JSON.stringify({ id, result: result ?? null })),
            (e) => send(JSON.stringify({ id, error: (e as Error)?.message ?? String(e) })),
          );
      }
    });
    const done = () => {
      unsubscribe.forEach((off) => off());
      sockets.delete(socket);
    };
    socket.on('close', done);
    socket.on('error', done);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}
