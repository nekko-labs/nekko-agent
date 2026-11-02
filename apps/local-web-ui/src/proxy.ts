import { Agent, request, type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { hostAllowed, originAllowed, tokenMatches } from './security.js';
import type { RequestSecurityOptions } from './request-security.js';

/**
 * The public side of the Local Web UI in front of nekkod.
 *
 * Channel calls are re-sent to the daemon's `POST /api/:channel` with the
 * daemon's own per-launch token; sockets (`/api/events`,
 * `/api/term/:id`) are checked here exactly as `createApiSecurityHook` checks
 * HTTP, then spliced to the daemon byte for byte, so a terminal's binary frames
 * cost one extra loopback copy and nothing else. The public token, Host and
 * Origin never reach the daemon, and no URL carrying a token is logged.
 */

export interface Upstream {
  port: number;
  token: string;
}

/** Keep-alive, and no client timeouts: some channel calls (downloads, model loads) legitimately run for minutes. */
const agent = new Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 64 });

export interface ForwardResult {
  status: number;
  body: string;
}

/** One channel call on the daemon. The body is passed through untouched. */
export function forwardCall(upstream: Upstream, channel: string, body: string): Promise<ForwardResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        agent,
        host: '127.0.0.1',
        port: upstream.port,
        method: 'POST',
        path: `/api/${encodeURIComponent(channel)}`,
        headers: {
          Host: `127.0.0.1:${upstream.port}`,
          Authorization: `Bearer ${upstream.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** The socket routes the daemon serves. */
export function isSocketRoute(pathname: string): boolean {
  // Never `/api/ws`: that socket is the desktop window's, and it reaches paired computers.
  return pathname === '/api/events' || /^\/api\/term\/[^/]+$/.test(pathname);
}

/**
 * The same checks as `createApiSecurityHook`, for an upgrade request. A page
 * cannot set headers on a WebSocket, so the token may also come as `?token=`
 * (what the web client sends), compared in constant time.
 */
export function upgradeAllowed(req: IncomingMessage, url: URL, options: RequestSecurityOptions): { ok: true } | { ok: false; status: number; reason: string } {
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  if (!hostAllowed(req.headers.host, options.host, options.port, options.allowedHosts)) return { ok: false, status: 400, reason: 'Bad Request' };
  if (!originAllowed(req.headers.origin, protocol, req.headers.host, options.allowedOrigins)) return { ok: false, status: 403, reason: 'Forbidden' };
  if (!options.token) return { ok: true };
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!tokenMatches(options.token, bearer ?? url.searchParams.get('token') ?? undefined)) return { ok: false, status: 401, reason: 'Unauthorized' };
  return { ok: true };
}

/** The upstream path: the public query minus the public token. */
export function upstreamPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('token');
  const q = params.toString();
  return `${url.pathname}${q ? `?${q}` : ''}`;
}

/** Headers of the client's handshake that the daemon needs to complete it. */
const PASSED = new Set(['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']);

export function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Splice an upgrade to the daemon: write a fresh handshake carrying the
 * daemon's token, then pipe both ways. The daemon's 101 (or refusal) goes back
 * to the client as is.
 */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: Upstream, path: string): void {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${upstream.port}`,
    `Authorization: Bearer ${upstream.token}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
  ];
  for (const [name, value] of Object.entries(req.headers)) {
    if (PASSED.has(name) && typeof value === 'string') lines.push(`${name}: ${value}`);
  }
  const up = net.connect(upstream.port, '127.0.0.1');
  up.setNoDelay(true);
  (socket as net.Socket).setNoDelay?.(true);
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', close);
  socket.on('error', close);
  up.on('close', () => socket.destroy());
  socket.on('close', () => up.destroy());
  up.once('connect', () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
}
