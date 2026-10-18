import type { FastifyInstance } from 'fastify';

/**
 * Registers `POST /api/hooks/:slug` on a Fastify instance.
 *
 * The route validates a per-trigger secret in the `?key=` query parameter,
 * enforces a 10 MB body cap, applies a per-slug rate limit, and forwards the
 * parsed payload to the host. The secret is compared in constant time and is
 * never logged.
 */

const BODY_LIMIT = 10 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

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

// Sweep stale rate-limit buckets so the map does not grow forever with
// one-off slug:ip pairs.
const sweepTimer = setInterval(() => pruneRateBuckets(Date.now()), RATE_WINDOW_MS);
(sweepTimer as unknown as { unref?: () => void }).unref?.();

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

/** What the route starts runs on: nekkod's `workflow:webhook`. */
export interface WebhookTarget {
  dispatchWebhook(slug: string, secret: string, payload: Record<string, unknown>): Promise<{ length: number }>;
}

export function registerWebhookRoutes(app: FastifyInstance, host: WebhookTarget): void {
  app.post<{ Params: { slug: string } }>('/api/hooks/:slug', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const slug = req.params.slug;
    const secret = (req.query as Record<string, string> | undefined)?.key ?? '';
    if (!secret) {
      reply.code(401).send({ error: 'missing key' });
      return;
    }
    const ip = req.ip;
    if (!checkRateLimit(rateLimitKey(slug, ip), Date.now())) {
      reply.code(429).send({ error: 'rate limit exceeded' });
      return;
    }
    const raw = JSON.stringify(req.body);
    const payload = parseWebhookPayload(raw);
    try {
      const runs = await host.dispatchWebhook(slug, secret, payload);
      reply.send({ started: runs.length });
    } catch (e) {
      if ((e as Error & { code?: string }).code === 'WEBHOOK_UNAUTHORIZED') {
        reply.code(403).send({ error: 'unauthorized' });
        return;
      }
      reply.code(400).send({ error: (e as Error).message });
    }
  });
}
