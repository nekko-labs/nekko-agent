import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { parseSignup, recordSignup } from "./signups.js";

export interface ServerOptions {
  db: Db;
  /** Origins allowed to call the API from a browser, e.g. https://nekkoagent.com. */
  allowedOrigins: string[];
  /** Signups per IP per window before 429. */
  rateLimit?: { max: number; windowMs: number };
  logger?: boolean;
}

export const DEFAULT_ORIGINS = ["https://nekkoagent.com", "https://www.nekkoagent.com"];

export function buildServer(opts: ServerOptions): FastifyInstance {
  // Render puts one proxy in front of the service; trust it for the client IP.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: (_addr: string, hop: number) => hop === 0, bodyLimit: 8 * 1024 });
  const origins = new Set(opts.allowedOrigins);
  const { max, windowMs } = opts.rateLimit ?? { max: 5, windowMs: 60 * 60 * 1000 };
  const hits = new Map<string, { count: number; resetAt: number }>();

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });

  app.options("/v1/signups", async (req, reply) => {
    if (!req.headers.origin || !origins.has(req.headers.origin)) return reply.code(403).send();
    reply
      .header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "content-type")
      .header("access-control-max-age", "86400")
      .code(204)
      .send();
  });

  // Render's health check, and what the page can call on load to wake a
  // free-plan instance before anyone presses Join.
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/signups", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return reply.code(403).send({ error: "Origin not allowed." });

    const now = Date.now();
    const hit = hits.get(req.ip);
    if (hit && hit.resetAt > now) {
      if (++hit.count > max) return reply.code(429).send({ error: "Too many signups. Try again later." });
    } else {
      hits.set(req.ip, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
    }

    const body = req.body as Record<string, unknown> | undefined;
    // Honeypot: a hidden field people never fill. Pretend it worked.
    if (body && typeof body.website === "string" && body.website !== "") return reply.code(202).send({ ok: true });

    const parsed = parseSignup(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    await recordSignup(opts.db, parsed.value);
    // Same answer for new and repeat signups, so the form can't be used to
    // check whether an address is already on the list.
    return reply.code(202).send({ ok: true });
  });

  return app;
}
