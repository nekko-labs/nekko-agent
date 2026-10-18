import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { brandEnv } from '@nekko-agent/shared';
import type { Host } from '@nekko-agent/host';

/**
 * Opt-in loopback webhook listener for the desktop app.
 *
 * Binds to 127.0.0.1 only (per the existing bind-localhost constraint) and is
 * off by default. When enabled, it exposes `POST /api/hooks/:slug` with the
 * same per-trigger secret auth, 10 MB body cap, and rate limit as the server
 * edition, and forwards validated calls to the host.
 */

const PORT = Number(brandEnv('LOOPBACK_PORT') ?? 1441);
const HOST = '127.0.0.1';
const BODY_LIMIT = 10 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

let server: Server | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitKey(slug: string, ip: string | undefined): string {
  return `${slug}:${ip ?? 'unknown'}`;
}

function pruneRateBuckets(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}

function checkRateLimit(key: string, now: number): boolean {
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (bucket) rateBuckets.delete(key);
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

export function parseWebhookPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      (parsed as Record<string, unknown>).__raw = raw;
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* body is not JSON */
  }
  return { __raw: raw };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function remoteAddress(req: IncomingMessage): string | undefined {
  const raw = req.socket.remoteAddress;
  if (!raw || raw === '::ffff:127.0.0.1') return '127.0.0.1';
  return raw;
}

async function handle(req: IncomingMessage, res: ServerResponse, host: Host): Promise<void> {
  if (!host.getSettings().experimental?.workflowLoopbackListener) {
    send(res, 503, { error: 'workflow loopback listener is disabled' });
    return;
  }

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const match = url.pathname.match(/^\/api\/hooks\/([^/]+)$/);
  if (!match || req.method !== 'POST') {
    send(res, 404, { error: 'not found' });
    return;
  }
  const slug = match[1];
  const secret = url.searchParams.get('key') ?? '';
  if (!secret) {
    send(res, 401, { error: 'missing key' });
    return;
  }
  if (!checkRateLimit(rateLimitKey(slug, remoteAddress(req)), Date.now())) {
    send(res, 429, { error: 'rate limit exceeded' });
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  const body = await new Promise<string>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > BODY_LIMIT) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  }).catch(() => '');

  if (!body) {
    send(res, 413, { error: 'body too large' });
    return;
  }

  const payload = parseWebhookPayload(body);
  try {
    const runs = await host.dispatchWebhook(slug, secret, payload);
    send(res, 200, { started: runs.length });
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'WEBHOOK_UNAUTHORIZED') {
      send(res, 403, { error: 'unauthorized' });
      return;
    }
    send(res, 400, { error: (e as Error).message });
  }
}

function startServer(host: Host): void {
  if (server) return;
  server = createServer((req, res) => {
    void handle(req, res, host);
  });
  server.on('error', (err) => {
    console.error('[workflow-listener] loopback server error:', err.message);
    server = null;
  });
  server.listen(PORT, HOST, () => {
    console.log(`[workflow-listener] listening on http://${HOST}:${PORT}`);
  });
}

function stopServer(): void {
  if (!server) return;
  server.close(() => {
    console.log('[workflow-listener] stopped');
  });
  server = null;
}

/** Watch the experimental flag and start/stop the loopback server as needed. */
export function manageWorkflowLoopbackListener(host: Host): void {
  const sync = () => {
    if (host.getSettings().experimental?.workflowLoopbackListener) {
      startServer(host);
    } else {
      stopServer();
    }
  };
  sync();
  checkTimer = setInterval(sync, 5_000);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => pruneRateBuckets(Date.now()), RATE_WINDOW_MS);
  }
}

export function closeWorkflowLoopbackListener(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  stopServer();
}
