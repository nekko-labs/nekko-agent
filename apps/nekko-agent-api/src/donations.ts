import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { bytes } from "./sync.js";

/**
 * "Help improve Nekko Agent": opt-in samples, sealed on the device to Nekko
 * Labs' offline research key (crates/nekko-sync `seal_donation`). The upload
 * is unauthenticated and nothing about the sender is stored, not even the IP
 * (the rate limit keeps counts in memory only). Whoever holds the delete token
 * the device kept can withdraw a donation; anything left expires in 180 days.
 */

export const MAX_DONATION_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/;
// version, ephemeral key, the smallest padded frame, tag.
const MIN_DONATION_BYTES = 1 + 65 + 256 + 16;

export function registerDonations(app: FastifyInstance, db: Db, rateLimit: { max: number; windowMs: number }): void {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // logLevel silent: Fastify's request log would otherwise record the sender's IP.
  app.post("/v1/donations", { bodyLimit: MAX_DONATION_BYTES * 2, logLevel: "silent" }, async (req, reply) => {
    const now = Date.now();
    const hit = hits.get(req.ip);
    if (hit && hit.resetAt > now) {
      if (++hit.count > rateLimit.max) return reply.code(429).send({ error: "rate-limited" });
    } else {
      hits.set(req.ip, { count: 1, resetAt: now + rateLimit.windowMs });
      if (hits.size > 10_000) for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blob = bytes(body.blob, MIN_DONATION_BYTES, MAX_DONATION_BYTES);
    const deleteHash = bytes(body.deleteHash, 32);
    if (typeof body.id !== "string" || !ID.test(body.id) || !blob || !deleteHash) return reply.code(400).send({ error: "bad donation" });
    await db.query("insert into donations (id, blob, delete_hash) values ($1, $2, $3) on conflict (id) do nothing", [body.id, blob, deleteHash]);
    return reply.code(202).send({ ok: true });
  });

  app.delete("/v1/donations/:id", { logLevel: "silent" }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = bytes(req.headers["x-delete-token"], 32);
    if (!ID.test(id) || !token) return reply.code(400).send({ error: "bad request" });
    const { rows } = await db.query<{ delete_hash: Buffer }>("select delete_hash from donations where id = $1", [id]);
    const want = rows[0] ? Buffer.from(rows[0].delete_hash) : null;
    const got = createHash("sha256").update(token).digest();
    if (!want || !timingSafeEqual(want, got)) return reply.code(404).send({ error: "not-found" });
    await db.query("delete from donations where id = $1", [id]);
    return reply.code(204).send();
  });
}

/** Drops expired donations; run on start and daily. */
export async function expireDonations(db: Db): Promise<void> {
  await db.query("delete from donations where expires_on < current_date", []);
}
