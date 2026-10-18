import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { URL } from 'node:url';
import {
  apiServerBindHost,
  apiServerClientUrl,
  apiServerRefusal,
  apiServerUrl,
  IpcEvents,
  withApiServerDefaults,
  type ApiServerSettings,
  type ApiServerStatus,
} from '@nekko-agent/shared';
import { createDispatcher, daemonLink, type Host } from '@nekko-agent/host';

/**
 * The desktop app, served to other programs.
 *
 * `POST /api/:channel` with `{ args: [...] }` and a `/api/events` socket are the
 * surface the CLI and the MCP server already speak, so switching this on makes
 * `nekko-agent chat "…"` and an MCP client drive *this* window's host — the same
 * providers, workspaces and sessions — instead of a second process on the same
 * files.
 *
 * Deliberately built on `node:http` with a small WebSocket of its own rather
 * than on the server edition's Fastify stack: the desktop app would otherwise
 * carry a web framework for a feature most people never turn on.
 *
 * Every request is authenticated. There is no anonymous mode and no way to
 * configure one, because this endpoint can run shell commands: an open port
 * here is a remote shell, and on a laptop's network it is a remote shell for
 * whoever else is on it.
 */

const BODY_LIMIT = 25 * 1024 * 1024;
/** RFC 6455's handshake constant. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let server: Server | null = null;
let sockets = new Set<Socket>();
let applied: ApiServerSettings | null = null;
let lastError: string | undefined;
let requests = 0;
let lastRequestAt: number | undefined;

/** A fresh bearer token: 32 bytes of randomness, url-safe. */
export function newApiToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Constant-time bearer comparison, so a wrong token leaks nothing by timing. */
export function tokenMatches(expected: string, got: string | undefined): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token on a request, from the header or (sockets can't set one) the query. */
export function bearerOf(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return url.searchParams.get('token') ?? undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The endpoint is for programs, not pages: no browser origin is allowed to
    // reach it, so a page the user happens to have open cannot drive the agent.
    'Access-Control-Allow-Origin': 'null',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) {
      req.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One text frame, unmasked, as a server sends it. Only the three length forms
 * matter: everything here is a JSON event, and a big one is still just a frame
 * with a 64-bit length.
 */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  let header: Buffer;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * The handshake reply for a client key, per RFC 6455. Split out because it is
 * the one part of the protocol that is exactly specified and worth testing.
 */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/**
 * Walk the frames a client sent and report the control ones.
 *
 * Nothing is ever *read* from these sockets — events only flow outwards — but a
 * close frame still has to be noticed, or the app holds a socket the client
 * believes it hung up. Returns whatever is left of a partial frame so the next
 * chunk can finish it.
 */
export function readControlFrames(buffer: Buffer): { closed: boolean; rest: Buffer } {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length < offset + 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length < offset + 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const total = headerLength + (masked ? 4 : 0) + length;
    if (buffer.length < offset + total) break;
    if (opcode === 0x8) return { closed: true, rest: Buffer.alloc(0) };
    offset += total;
  }
  return { closed: false, rest: buffer.subarray(offset) };
}

function closeSockets(): void {
  for (const socket of sockets) socket.destroy();
  sockets = new Set();
}

/**
 * Every chat's agent events, as `{ channel, payload }` frames, until the
 * returned stop is called.
 *
 * Under the engine daemon they come from the daemon (`/api/events?only=`),
 * which publishes the turns it drives itself; this host's bus no longer
 * carries those (it hears only how they end). Without one, from the bus.
 */
export function streamAgentEvents(host: Host, write: (frame: string) => void, link = daemonLink()): () => void {
  if (!link) {
    const forward = (payload: unknown) => write(JSON.stringify({ channel: IpcEvents.agentEvent, payload }));
    host.events.on('agentEvent', forward);
    return () => host.events.off('agentEvent', forward);
  }
  let stopped = false;
  let ws: WebSocket | null = null;
  const connect = () => {
    if (stopped) return;
    const url = `${link.url.replace(/^http/, 'ws')}/api/events?only=${encodeURIComponent(IpcEvents.agentEvent)}&token=${encodeURIComponent(link.token)}`;
    const next = new WebSocket(url);
    ws = next;
    next.onmessage = (ev) => write(String(ev.data));
    // An error is always followed by close, which reconnects.
    next.onclose = () => {
      if (ws === next && !stopped) setTimeout(connect, 500);
    };
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}

function handleUpgrade(req: IncomingMessage, socket: Socket, settings: ApiServerSettings, host: Host): void {
  const url = new URL(req.url ?? '/', `http://localhost:${settings.port}`);
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/api/events' || typeof key !== 'string') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  if (!tokenMatches(settings.token, bearerOf(req, url))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  sockets.add(socket);

  const write = (frame: string) => {
    if (!socket.destroyed) socket.write(encodeTextFrame(frame));
  };
  const stop = streamAgentEvents(host, write);

  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const { closed, rest } = readControlFrames(pending);
    pending = rest;
    if (closed) socket.destroy();
  });

  const done = () => {
    stop();
    sockets.delete(socket);
  };
  socket.on('close', done);
  socket.on('error', done);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  settings: ApiServerSettings,
  dispatch: (channel: string, args: unknown[]) => unknown,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${settings.port}`);

  if (!tokenMatches(settings.token, bearerOf(req, url))) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  // A "what is this port" probe, so a misconfigured client gets a name instead
  // of a 404 it has to guess at.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true, app: 'nekko-agent', edition: 'desktop' });
    return;
  }
  const channel = url.pathname.startsWith('/api/') ? url.pathname.slice('/api/'.length) : '';
  if (req.method !== 'POST' || !channel) {
    send(res, 404, { error: 'not found' });
    return;
  }

  const raw = await readBody(req);
  if (raw === null) {
    send(res, 413, { error: 'body too large' });
    return;
  }
  let args: unknown[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (Array.isArray(parsed?.args)) args = parsed.args;
  } catch {
    send(res, 400, { error: 'body is not JSON' });
    return;
  }

  requests += 1;
  lastRequestAt = Date.now();
  try {
    send(res, 200, (await dispatch(channel, args)) ?? null);
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}

function start(settings: ApiServerSettings, host: Host): void {
  const refusal = apiServerRefusal(settings);
  if (refusal) {
    lastError = refusal;
    return;
  }
  const dispatch = createDispatcher(host);
  requests = 0;
  lastRequestAt = undefined;

  const next = createServer((req, res) => {
    void handle(req, res, settings, dispatch).catch(() => send(res, 500, { error: 'internal error' }));
  });
  next.on('upgrade', (req, socket) => handleUpgrade(req, socket as Socket, settings, host));
  next.on('error', (err) => {
    // A port already in use is the common one, and the Models tab says so
    // rather than showing a server that claims to be running and is not.
    lastError = err.message;
    server = null;
    applied = null;
  });
  next.listen(settings.port, apiServerBindHost(settings), () => {
    lastError = undefined;
  });
  server = next;
  applied = settings;
}

function stop(): void {
  closeSockets();
  server?.close();
  server = null;
  applied = null;
}

/** Bring the server in line with the saved settings. Safe to call repeatedly. */
export function syncApiServer(host: Host): void {
  const settings = withApiServerDefaults(host.getSettings().apiServer);
  const same =
    applied &&
    applied.port === settings.port &&
    applied.bind === settings.bind &&
    (applied.host ?? '') === (settings.host ?? '') &&
    applied.token === settings.token;
  if (settings.enabled && server && same) return;

  stop();
  if (settings.enabled) start(settings, host);
  else lastError = undefined;
}

/**
 * This machine's first non-internal IPv4 address, for quoting a LAN bind as
 * something another device can dial. Undefined when there is none (offline,
 * or only loopback), in which case loopback is quoted, which at least works
 * from here.
 */
export function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  return undefined;
}

/**
 * Mint a token when the server is on and has none.
 *
 * The server is on by default, and a fresh install has no token yet; without
 * one `start` refuses (an unauthenticated agent endpoint is a remote shell), so
 * the default would be a server that is "on" and never listening. Minting it
 * here, before the first sync, is what makes on-by-default actually serve.
 */
export function ensureApiServerToken(host: Host): void {
  const settings = withApiServerDefaults(host.getSettings().apiServer);
  if (settings.enabled && !settings.token.trim()) {
    host.updateSettings({ apiServer: { ...settings, token: newApiToken() } });
  }
}

/** Everything the Models tab needs to draw the server card. */
export function apiServerStatus(host: Host): ApiServerStatus {
  const settings = withApiServerDefaults(host.getSettings().apiServer);
  const running = Boolean(server?.listening);
  const lan = lanAddress();
  return {
    settings,
    running,
    available: true,
    url: running ? apiServerUrl(settings, lan) : undefined,
    clientUrl: apiServerClientUrl(settings, lan),
    error: settings.enabled && !running ? lastError ?? 'Not listening.' : undefined,
    clients: sockets.size,
    requests,
    lastRequestAt,
  };
}

/** Shut it down on quit, so the port is free for the next launch. */
export function closeApiServer(): void {
  stop();
}
