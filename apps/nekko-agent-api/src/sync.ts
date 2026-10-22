import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, type Plan, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";

/**
 * End-to-end encrypted sync (docs/SYNC-ENCRYPTION.md). The server stores
 * opaque blobs and the few numbers it needs to order them; it never holds a
 * key that opens one. What it checks is only what it can: sizes, shapes,
 * revisions, plans and ownership.
 */

/** Stored bytes allowed per account. */
export const SYNC_QUOTA: Record<Plan, number> = { free: 0, pro: 5 * 2 ** 30, team: 20 * 2 ** 30 };
/** One sealed object at most (a transcript is split into parts well under this). */
export const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_PUSH = 200;
const MAX_PULL = 500;
// Exact sizes from crates/nekko-sync: version, ephemeral key, 64-byte keyring, GCM tag. The
// recovery wrap is sealed to the recovery key's public half the same way.
const WRAP_BYTES = 1 + 65 + 64 + 16;
const RECOVERY_BYTES = WRAP_BYTES;
// version, salt, the smallest padded frame (256), tag.
const MIN_OBJECT_BYTES = 1 + 32 + 256 + 16;

const B64URL = /^[A-Za-z0-9_-]*$/;
const COLLECTION = /^[a-z][a-z0-9-]{0,31}$/;
const OBJECT_ID = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict base64url (no padding, canonical), or null. */
export function bytes(value: unknown, min: number, max = min): Buffer | null {
  if (typeof value !== "string" || !B64URL.test(value)) return null;
  const buf = Buffer.from(value, "base64url");
  if (buf.toString("base64url") !== value || buf.length < min || buf.length > max) return null;
  return buf;
}

const isPositiveInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

interface ObjectRow {
  collection: string;
  object_id: string;
  revision: string;
  key_id: number;
  blob: Buffer;
  seq: string;
}

const wire = (r: ObjectRow) => ({
  collection: r.collection,
  objectId: r.object_id,
  revision: Number(r.revision),
  keyId: r.key_id,
  blob: Buffer.from(r.blob).toString("base64url"),
  seq: Number(r.seq),
});

async function currentKeyId(db: Db, userId: string): Promise<number | null> {
  const { rows } = await db.query<{ k: number | null }>("select max(key_id) as k from sync_keyrings where user_id = $1", [userId]);
  return rows[0]?.k ?? null;
}

export function registerSync(app: FastifyInstance, db: Db): void {
  /** Authenticates, and for writes checks the plan. Replies itself on failure. */
  async function guard(req: FastifyRequest, reply: FastifyReply, write: boolean): Promise<Caller | null> {
    const caller = await authenticate(db, req);
    if (!caller) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (write && !SYNC_PLANS.has(caller.plan)) {
      reply.code(402).send({ error: "plan-required", plan: caller.plan, needs: ["pro", "team"] });
      return null;
    }
    return caller;
  }

  app.get("/v1/sync/state", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const [devices, usage, keyId] = await Promise.all([
      db.query<{ id: string; label: string; public_key: Buffer; created_at: Date; revoked_at: Date | null }>(
        "select id, label, public_key, created_at, revoked_at from sync_devices where user_id = $1 order by created_at",
        [caller.userId],
      ),
      db.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [caller.userId]),
      currentKeyId(db, caller.userId),
    ]);
    return {
      account: caller.userId,
      plan: caller.plan,
      canWrite: SYNC_PLANS.has(caller.plan),
      device: caller.deviceId,
      currentKeyId: keyId,
      devices: devices.rows.map((d) => ({
        id: d.id,
        label: d.label,
        publicKey: Buffer.from(d.public_key).toString("base64url"),
        createdAt: d.created_at,
        revokedAt: d.revoked_at,
      })),
      usage: { bytes: Number(usage.rows[0]?.bytes ?? 0), limit: SYNC_QUOTA[caller.plan] },
    };
  });

  // A device registers its public key; the calling token becomes that device's.
  app.post("/v1/sync/devices", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publicKey = bytes(body.publicKey, 65);
    const label = typeof body.label === "string" ? body.label.trim().replace(/\s+/g, " ") : "";
    if (!publicKey || publicKey[0] !== 4) return reply.code(400).send({ error: "publicKey must be a 65-byte uncompressed P-256 key" });
    if (!label || label.length > 40) return reply.code(400).send({ error: "label must be 1 to 40 characters" });
    if (caller.deviceId) return reply.code(409).send({ error: "token-has-device", deviceId: caller.deviceId });
    return db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; revoked_at: Date | null }>(
        `insert into sync_devices (user_id, public_key, label) values ($1, $2, $3)
         on conflict (user_id, public_key) do update set label = sync_devices.label
         returning id, revoked_at`,
        [caller.userId, publicKey, label],
      );
      // A revoked key stays revoked: a device comes back only with a new key.
      if (rows[0].revoked_at) return reply.code(403).send({ error: "device-revoked" });
      await tx.query("update api_tokens set device_id = $1 where id = $2", [rows[0].id, caller.tokenId]);
      return reply.code(201).send({ deviceId: rows[0].id });
    });
  });

  // Revoking a device revokes its tokens and drops its wraps. The devices
  // left should then rotate to a new key epoch (the client does this).
  app.delete("/v1/sync/devices/:id", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "not-found" });
    return db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "update sync_devices set revoked_at = coalesce(revoked_at, now()) where id = $1 and user_id = $2 returning id",
        [id, caller.userId],
      );
      if (!rows.length) return reply.code(404).send({ error: "not-found" });
      await tx.query("update api_tokens set revoked_at = coalesce(revoked_at, now()) where device_id = $1", [id]);
      await tx.query("delete from sync_key_wraps where device_id = $1", [id]);
      return reply.code(204).send();
    });
  });

  // A new key epoch: the keyring wrapped to the recovery key and to devices.
  app.put("/v1/sync/keyrings/:keyId", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const keyId = Number((req.params as { keyId: string }).keyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recovery = bytes(body.recoveryWrap, RECOVERY_BYTES);
    const wraps = Array.isArray(body.wraps) ? body.wraps : null;
    if (!isPositiveInt(keyId, 1_000_000) || !recovery || !wraps || wraps.length > 100) {
      return reply.code(400).send({ error: "expected recoveryWrap and wraps for a positive keyId" });
    }
    const parsed: { deviceId: string; wrap: Buffer }[] = [];
    for (const w of wraps as Record<string, unknown>[]) {
      const wrap = bytes(w?.wrap, WRAP_BYTES);
      if (typeof w?.deviceId !== "string" || !UUID.test(w.deviceId) || !wrap) return reply.code(400).send({ error: "bad wrap" });
      parsed.push({ deviceId: w.deviceId, wrap });
    }
    return db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
      const current = (await currentKeyId(tx, caller.userId)) ?? 0;
      if (keyId !== current + 1) return reply.code(409).send({ error: "key-epoch", currentKeyId: current || null });
      await tx.query("insert into sync_keyrings (user_id, key_id, recovery_wrap) values ($1, $2, $3)", [caller.userId, keyId, recovery]);
      for (const w of parsed) {
        const ok = await insertWrap(tx, caller.userId, keyId, w.deviceId, w.wrap);
        if (!ok) throw Object.assign(new Error("unknown device"), { statusCode: 400 });
      }
      return reply.code(201).send({ keyId });
    }).catch((e: { statusCode?: number; message: string }) => {
      if (e.statusCode === 400) return reply.code(400).send({ error: "unknown-device" });
      throw e;
    });
  });

  // An existing device adds a wrap for a newly enrolled one.
  app.put("/v1/sync/keyrings/:keyId/wraps/:deviceId", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const { keyId: rawKey, deviceId } = req.params as { keyId: string; deviceId: string };
    const keyId = Number(rawKey);
    const wrap = bytes((req.body as Record<string, unknown> | undefined)?.wrap, WRAP_BYTES);
    if (!isPositiveInt(keyId, 1_000_000) || !UUID.test(deviceId) || !wrap) return reply.code(400).send({ error: "bad wrap" });
    const exists = await db.query("select 1 from sync_keyrings where user_id = $1 and key_id = $2", [caller.userId, keyId]);
    if (!exists.rows.length) return reply.code(404).send({ error: "not-found" });
    if (!(await insertWrap(db, caller.userId, keyId, deviceId, wrap))) return reply.code(400).send({ error: "unknown-device" });
    return reply.code(204).send();
  });

  app.get("/v1/sync/keyrings/:keyId", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const keyId = Number((req.params as { keyId: string }).keyId);
    if (!isPositiveInt(keyId, 1_000_000)) return reply.code(404).send({ error: "not-found" });
    const { rows } = await db.query<{ recovery_wrap: Buffer; wrap: Buffer | null }>(
      `select k.recovery_wrap, w.wrap from sync_keyrings k
         left join sync_key_wraps w on w.user_id = k.user_id and w.key_id = k.key_id and w.device_id = $3
        where k.user_id = $1 and k.key_id = $2`,
      [caller.userId, keyId, caller.deviceId],
    );
    if (!rows.length) return reply.code(404).send({ error: "not-found" });
    return {
      keyId,
      recoveryWrap: Buffer.from(rows[0].recovery_wrap).toString("base64url"),
      wrap: rows[0].wrap ? Buffer.from(rows[0].wrap).toString("base64url") : null,
    };
  });

  // Push sealed revisions. Each object's revision must be exactly one past
  // what the server has (1 for a new one); otherwise that object is a
  // conflict and the device pulls, merges and retries. Writes go under the
  // current key epoch only, so a rotation takes effect at once.
  app.post("/v1/sync/push", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const objects = (req.body as Record<string, unknown> | undefined)?.objects;
    if (!Array.isArray(objects) || objects.length < 1 || objects.length > MAX_PUSH) {
      return reply.code(400).send({ error: `objects must hold 1 to ${MAX_PUSH} records` });
    }
    const parsed: { collection: string; objectId: string; revision: number; keyId: number; blob: Buffer }[] = [];
    for (const o of objects as Record<string, unknown>[]) {
      const blob = bytes(o?.blob, MIN_OBJECT_BYTES, MAX_OBJECT_BYTES);
      if (typeof o?.collection !== "string" || !COLLECTION.test(o.collection) || typeof o.objectId !== "string" || !OBJECT_ID.test(o.objectId)
        || !isPositiveInt(o.revision) || !isPositiveInt(o.keyId, 1_000_000) || !blob) {
        return reply.code(400).send({ error: "bad object" });
      }
      parsed.push({ collection: o.collection, objectId: o.objectId, revision: o.revision, keyId: o.keyId, blob });
    }
    return db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
      const keyId = await currentKeyId(tx, caller.userId);
      const results: Record<string, unknown>[] = [];
      let delta = 0;
      for (const o of parsed) {
        if (o.keyId !== keyId) {
          results.push({ objectId: o.objectId, status: "stale-key", currentKeyId: keyId });
          continue;
        }
        const { rows } = await tx.query<{ revision: string; size: number }>(
          "select revision, octet_length(blob) as size from sync_objects where user_id = $1 and collection = $2 and object_id = $3",
          [caller.userId, o.collection, o.objectId],
        );
        const have = rows[0] ? Number(rows[0].revision) : 0;
        if (o.revision !== have + 1) {
          results.push({ objectId: o.objectId, status: "conflict", revision: have });
          continue;
        }
        await tx.query(
          `insert into sync_objects (user_id, collection, object_id, revision, key_id, blob) values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id, collection, object_id) do update set
             revision = excluded.revision, key_id = excluded.key_id, blob = excluded.blob,
             seq = nextval('sync_change_seq'), updated_at = now()`,
          [caller.userId, o.collection, o.objectId, o.revision, o.keyId, o.blob],
        );
        delta += o.blob.length - (rows[0]?.size ?? 0);
        results.push({ objectId: o.objectId, status: "ok", revision: o.revision });
      }
      const { rows: usage } = await tx.query<{ bytes: string }>(
        `insert into sync_usage (user_id, bytes) values ($1, greatest($2::bigint, 0))
         on conflict (user_id) do update set bytes = greatest(sync_usage.bytes + $2::bigint, 0)
         returning bytes`,
        [caller.userId, delta],
      );
      if (Number(usage[0].bytes) > SYNC_QUOTA[caller.plan]) {
        // Roll the whole push back.
        throw Object.assign(new Error("quota"), { statusCode: 413 });
      }
      return { results };
    }).catch((e: { statusCode?: number }) => {
      if (e.statusCode === 413) return reply.code(413).send({ error: "quota", limit: SYNC_QUOTA[caller.plan] });
      throw e;
    });
  });

  // Changes after a sequence number, oldest first.
  app.get("/v1/sync/pull", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const q = req.query as Record<string, string | undefined>;
    const since = q.since === undefined ? 0 : Number(q.since);
    const limit = q.limit === undefined ? MAX_PULL : Number(q.limit);
    if (!Number.isSafeInteger(since) || since < 0 || !isPositiveInt(limit, MAX_PULL)) return reply.code(400).send({ error: "bad since or limit" });
    const { rows } = await db.query<ObjectRow>(
      `select collection, object_id, revision, key_id, blob, seq from sync_objects
        where user_id = $1 and seq > $2 order by seq limit $3`,
      [caller.userId, since, limit + 1],
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map(wire);
    return { objects: page, next: page.length ? page[page.length - 1].seq : since, more };
  });

  // Delete everything synced: objects, keyrings, wraps and devices. The
  // account itself stays. Works on any plan.
  app.delete("/v1/sync", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    await db.transaction(async (tx) => {
      await tx.query("delete from sync_objects where user_id = $1", [caller.userId]);
      await tx.query("delete from sync_keyrings where user_id = $1", [caller.userId]);
      await tx.query("update api_tokens set device_id = null where user_id = $1", [caller.userId]);
      await tx.query("delete from sync_devices where user_id = $1", [caller.userId]);
      await tx.query("delete from sync_usage where user_id = $1", [caller.userId]);
    });
    return reply.code(204).send();
  });
}

async function insertWrap(db: Db, userId: string, keyId: number, deviceId: string, wrap: Buffer): Promise<boolean> {
  const { rows } = await db.query(
    `insert into sync_key_wraps (user_id, key_id, device_id, wrap)
     select $1, $2, d.id, $4 from sync_devices d where d.id = $3 and d.user_id = $1 and d.revoked_at is null
     on conflict (user_id, key_id, device_id) do update set wrap = excluded.wrap
     returning device_id`,
    [userId, keyId, deviceId, wrap],
  );
  return rows.length === 1;
}
