import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, type Plan, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import { featuresFor, type Features } from "./features.js";
import { bodyWeight, holdMemory } from "./memory-gate.js";
import { HISTORY_DAYS, SYNC_QUOTA, bytes, isPositiveInt, shareBytes } from "./sync.js";

/**
 * Shared Library files (issue #2749), with versions and 30-day recovery
 * (#2750). The app seals a file with a fresh key and sends only the sealed
 * bytes; the key travels in the link's #fragment, which a browser never sends
 * to a server, so this service stores and serves bytes it can't open.
 *
 * Anyone with the id gets the sealed bytes (`GET /v1/s/:id`). Only the owner
 * lists, deletes, restores and goes back to a version. Changing the file
 * needs the owner, or an edit link's token (the service keeps its SHA-256).
 * Writing needs Pro or Enterprise and the `library-cloud` switch; reading,
 * deleting and restoring a deleted share never depend on either.
 */

/** One shared file at most, sealed. */
export const MAX_SHARE_BYTES = 10 * 1024 * 1024;
/** The smallest sealed file: a version byte, a 12-byte nonce and a 16-byte tag. */
const MIN_SHARE_BYTES = 1 + 12 + 16;
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
const EDIT_HEADER = "x-nekko-share-edit";
const EDIT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

interface ShareRow {
  id: string;
  user_id: string;
  revision: number;
  blob: Buffer;
  edit_hash: Buffer | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const summary = (r: Omit<ShareRow, "blob"> & { size: number }) => ({
  id: r.id, revision: r.revision, size: r.size, canEdit: !!r.edit_hash,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), deletedAt: iso(r.deleted_at),
});

export function registerShares(app: FastifyInstance, db: Db, f: Features): void {
  const unauthenticated = (reply: FastifyReply) => { reply.code(401).send({ error: "unauthenticated" }); return null; };

  /** The signed-in caller, for owner routes. */
  async function owner(req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
    return (await authenticate(db, req)) ?? unauthenticated(reply);
  }

  /** May this account write shares now: the switch is on for it and its plan pays for storage. */
  async function mayWrite(reply: FastifyReply, userId: string, plan: Plan): Promise<boolean> {
    // A 404 while the switch is off: the feature doesn't exist for this account yet.
    if (!(await featuresFor(db, f, userId)).features["library-cloud"]) { reply.code(404).send({ error: "not-found" }); return false; }
    if (!SYNC_PLANS.has(plan)) { reply.code(402).send({ error: "plan-required", plan, needs: ["pro", "team"] }); return false; }
    return true;
  }

  type ShareHead = Omit<ShareRow, "blob">;
  /** A share's row without its blob, for the checks that run before its body is read. */
  async function loadHead(id: string): Promise<ShareHead | null> {
    if (!SHARE_ID.test(id)) return null;
    const { rows } = await db.query<ShareHead>("select id, user_id, revision, edit_hash, created_at, updated_at, deleted_at from library_shares where id = $1", [id]);
    return rows[0] ?? null;
  }

  async function load(id: string): Promise<ShareRow | null> {
    if (!SHARE_ID.test(id)) return null;
    const { rows } = await db.query<ShareRow>("select * from library_shares where id = $1", [id]);
    return rows[0] ?? null;
  }

  /** The owner, or anyone holding the share's edit token. Null after replying. */
  async function editor(req: FastifyRequest, reply: FastifyReply, share: ShareHead): Promise<{ ownerPlan: Plan } | null> {
    const token = req.headers[EDIT_HEADER];
    if (typeof token === "string" && EDIT_TOKEN.test(token) && share.edit_hash && timingSafeEqual(sha256(token), Buffer.from(share.edit_hash))) {
      const { rows } = await db.query<{ plan: Plan }>("select plan from users where id = $1", [share.user_id]);
      return { ownerPlan: rows[0]?.plan ?? "free" };
    }
    const caller = await authenticate(db, req);
    if (caller?.userId === share.user_id) return { ownerPlan: caller.plan };
    reply.code(caller ? 404 : 401).send({ error: caller ? "not-found" : "unauthenticated" });
    return null;
  }

  /** Replace the share's bytes with a new revision, keeping the old one as a version. */
  async function replace(reply: FastifyReply, share: ShareRow, plan: Plan, blob: Buffer, expected: number) {
    return db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`share:${share.id}`]);
      const { rows } = await tx.query<{ revision: number }>("select revision from library_shares where id = $1 and deleted_at is null", [share.id]);
      if (!rows[0]) return reply.code(410).send({ error: "no-longer-shared" });
      if (rows[0].revision !== expected) return reply.code(409).send({ error: "conflict", revision: rows[0].revision });
      await tx.query(
        `insert into library_share_versions (share_id, revision, blob) select id, revision, blob from library_shares where id = $1
         on conflict do nothing`, [share.id]);
      await tx.query("update library_shares set blob = $2, revision = revision + 1, updated_at = now() where id = $1", [share.id, blob]);
      if (await overQuota(tx, share.user_id, plan)) throw Object.assign(new Error("quota"), { statusCode: 413 });
      return { id: share.id, revision: expected + 1 };
    }).catch((e: { statusCode?: number }) => {
      if (e.statusCode === 413) return reply.code(413).send({ error: "quota", limit: SYNC_QUOTA[plan] });
      throw e;
    });
  }

  async function overQuota(tx: Db, userId: string, plan: Plan): Promise<boolean> {
    const { rows } = await tx.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [userId]);
    return Number(rows[0]?.bytes ?? 0) + await shareBytes(tx, userId) > SYNC_QUOTA[plan];
  }

  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const sealed = (v: unknown) => bytes(v, MIN_SHARE_BYTES, MAX_SHARE_BYTES);
  const bodyLimit = Math.ceil(MAX_SHARE_BYTES * 4 / 3) + 4096;
  // Who the preParsing hooks below already checked, so the handlers do not check again.
  const vouched = new WeakMap<FastifyRequest, Caller | { ownerPlan: Plan }>();
  // A share's body waits for memory only once the caller is known (the rate limit already ran).
  const createGate = async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = await owner(req, reply);
    if (!caller) return reply;
    vouched.set(req, caller);
    const weight = bodyWeight(req);
    if (weight) await holdMemory(app, req, weight);
  };
  const replaceGate = async (req: FastifyRequest, reply: FastifyReply) => {
    const share = await loadHead((req.params as { id: string }).id);
    if (!share) return reply.code(404).send({ error: "not-found" });
    const who = await editor(req, reply, share);
    if (!who) return reply;
    vouched.set(req, who);
    const weight = bodyWeight(req);
    if (weight) await holdMemory(app, req, weight);
  };
  const limit = { bodyLimit, config: { gateAfterAuth: true } };

  app.post("/v1/shares", { ...limit, preParsing: createGate }, async (req, reply) => {
    const caller = (vouched.get(req) as Caller | undefined) ?? await owner(req, reply);
    if (!caller || !(await mayWrite(reply, caller.userId, caller.plan))) return;
    const blob = sealed(body(req).blob);
    const raw = body(req).editHash;
    const editHash = raw === undefined ? null : bytes(raw, 32);
    if (!blob || (raw !== undefined && !editHash)) return reply.code(400).send({ error: "bad share" });
    const id = randomBytes(16).toString("base64url");
    return db.transaction(async (tx) => {
      await tx.query("insert into library_shares (id, user_id, blob, edit_hash) values ($1, $2, $3, $4)", [id, caller.userId, blob, editHash]);
      if (await overQuota(tx, caller.userId, caller.plan)) throw Object.assign(new Error("quota"), { statusCode: 413 });
      return reply.code(201).send({ id, revision: 1 });
    }).catch((e: { statusCode?: number }) => {
      if (e.statusCode === 413) return reply.code(413).send({ error: "quota", limit: SYNC_QUOTA[caller.plan] });
      throw e;
    });
  });

  app.get("/v1/shares", async (req, reply) => {
    const caller = await owner(req, reply);
    if (!caller) return;
    const { rows } = await db.query<Omit<ShareRow, "blob"> & { size: number }>(
      `select id, user_id, revision, edit_hash, created_at, updated_at, deleted_at, octet_length(blob) as size
         from library_shares where user_id = $1 order by updated_at desc`, [caller.userId]);
    return { shares: rows.map(summary), keptDays: HISTORY_DAYS };
  });

  // The link's page reads this: sealed bytes only, to anyone with the id, from any site.
  app.get("/v1/s/:id", async (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("access-control-allow-origin", "*");
    const share = await load((req.params as { id: string }).id);
    if (!share) return reply.code(404).send({ error: "not-found" });
    if (share.deleted_at) return reply.code(410).send({ error: "no-longer-shared" });
    return { id: share.id, revision: share.revision, blob: Buffer.from(share.blob).toString("base64url") };
  });

  app.put("/v1/shares/:id", { ...limit, preParsing: replaceGate }, async (req, reply) => {
    const share = await load((req.params as { id: string }).id);
    if (!share) return reply.code(404).send({ error: "not-found" });
    const who = (vouched.get(req) as { ownerPlan: Plan } | undefined) ?? await editor(req, reply, share);
    if (!who || !(await mayWrite(reply, share.user_id, who.ownerPlan))) return;
    const blob = sealed(body(req).blob);
    const expected = body(req).revision;
    if (!blob || !isPositiveInt(expected, 1_000_000_000)) return reply.code(400).send({ error: "bad share" });
    return replace(reply, share, who.ownerPlan, blob, expected);
  });

  // Stop sharing: the link stops at once; the owner can restore it for HISTORY_DAYS. `?forever=1` deletes it now.
  app.delete("/v1/shares/:id", async (req, reply) => {
    const caller = await owner(req, reply);
    if (!caller) return;
    const share = await load((req.params as { id: string }).id);
    if (!share || share.user_id !== caller.userId) return reply.code(404).send({ error: "not-found" });
    if ((req.query as { forever?: string }).forever === "1") await db.query("delete from library_shares where id = $1", [share.id]);
    else await db.query("update library_shares set deleted_at = coalesce(deleted_at, now()) where id = $1", [share.id]);
    return reply.code(204).send();
  });

  app.post("/v1/shares/:id/restore", async (req, reply) => {
    const caller = await owner(req, reply);
    if (!caller) return;
    const share = await load((req.params as { id: string }).id);
    if (!share || share.user_id !== caller.userId) return reply.code(404).send({ error: "not-found" });
    await db.query("update library_shares set deleted_at = null where id = $1", [share.id]);
    return { id: share.id, revision: share.revision };
  });

  app.get("/v1/shares/:id/versions", async (req, reply) => {
    const share = await load((req.params as { id: string }).id);
    if (!share) return reply.code(404).send({ error: "not-found" });
    if (!(await editor(req, reply, share))) return;
    const { rows } = await db.query<{ revision: number; size: number; superseded_at: Date }>(
      "select revision, octet_length(blob) as size, superseded_at from library_share_versions where share_id = $1 order by revision desc", [share.id]);
    return {
      current: { revision: share.revision, size: share.blob.length, updatedAt: iso(share.updated_at) },
      versions: rows.map((r) => ({ revision: r.revision, size: r.size, supersededAt: iso(r.superseded_at) })),
      keptDays: HISTORY_DAYS,
    };
  });

  app.get("/v1/shares/:id/versions/:revision", async (req, reply) => {
    const { id, revision } = req.params as { id: string; revision: string };
    const share = await load(id);
    if (!share) return reply.code(404).send({ error: "not-found" });
    if (!(await editor(req, reply, share))) return;
    const { rows } = await db.query<{ blob: Buffer }>("select blob from library_share_versions where share_id = $1 and revision = $2", [share.id, Number(revision) || 0]);
    if (!rows[0]) return reply.code(404).send({ error: "not-found" });
    return { id: share.id, revision: Number(revision), blob: Buffer.from(rows[0].blob).toString("base64url") };
  });

  // Go back to a version: it becomes the newest revision, and what was current is kept as a version.
  app.post("/v1/shares/:id/versions/:revision/restore", async (req, reply) => {
    const caller = await owner(req, reply);
    if (!caller) return;
    const { id, revision } = req.params as { id: string; revision: string };
    const share = await load(id);
    if (!share || share.user_id !== caller.userId) return reply.code(404).send({ error: "not-found" });
    if (!(await mayWrite(reply, caller.userId, caller.plan))) return;
    const { rows } = await db.query<{ blob: Buffer }>("select blob from library_share_versions where share_id = $1 and revision = $2", [share.id, Number(revision) || 0]);
    if (!rows[0]) return reply.code(404).send({ error: "not-found" });
    return replace(reply, share, caller.plan, Buffer.from(rows[0].blob), share.revision);
  });
}

/** Drop what is past keeping: replaced revisions, old share versions, and shares deleted more than HISTORY_DAYS ago. */
export async function purgeLibraryHistory(db: Db, now = new Date()): Promise<{ revisions: number; versions: number; shares: number }> {
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  return db.transaction(async (tx) => {
    // Replaced sync revisions stop counting toward their account's storage as they go.
    const gone = await tx.query<{ user_id: string; bytes: string; n: string }>(
      `with gone as (delete from sync_object_history where superseded_at < $1 returning user_id, octet_length(blob) as size)
       select user_id, sum(size) as bytes, count(*) as n from gone group by user_id`, [cutoff]);
    for (const g of gone.rows) {
      await tx.query("update sync_usage set bytes = greatest(bytes - $2::bigint, 0) where user_id = $1", [g.user_id, Number(g.bytes)]);
    }
    const versions = await tx.query("delete from library_share_versions where superseded_at < $1 returning 1", [cutoff]);
    const shares = await tx.query("delete from library_shares where deleted_at < $1 returning 1", [cutoff]);
    return { revisions: gone.rows.reduce((t, g) => t + Number(g.n), 0), versions: versions.rows.length, shares: shares.rows.length };
  });
}
