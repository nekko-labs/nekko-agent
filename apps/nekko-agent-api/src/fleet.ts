import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import { bytes, currentKeyId, keyed } from "./sync.js";

/** Discovery only. Clients must authenticate the descriptor and the peer; a
 * row (even an online one) never grants access to a computer. Off by default. */
export const FLEET_LEASE_SECONDS = 90;
export const MAX_FLEET_COMPUTERS = 100;
export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MIN_DESCRIPTOR_BYTES = 1 + 32 + 256 + 16; // nekko-sync v1 padded sealed record

interface ComputerRow {
  device_id: string;
  key_id: number;
  revision: string;
  descriptor: Buffer;
  seen_at: Date;
  expires_at: Date;
  online: boolean;
}

const wire = (r: ComputerRow) => ({
  deviceId: r.device_id,
  keyId: r.key_id,
  revision: Number(r.revision),
  descriptor: Buffer.from(r.descriptor).toString("base64url"),
  seenAt: r.seen_at,
  expiresAt: r.expires_at,
  online: r.online,
});

export function registerFleet(app: FastifyInstance, db: Db): void {
  async function guard(tx: Db, req: FastifyRequest, reply: FastifyReply, write: boolean): Promise<Caller | null> {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(tx, req);
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

  async function unlocked(tx: Db, caller: Caller, reply: FastifyReply): Promise<number | null> {
    const epoch = await currentKeyId(tx, caller.userId);
    if (epoch === null || !(await keyed(tx, caller, epoch))) {
      reply.code(403).send({ error: "needs-synced-device" });
      return null;
    }
    return epoch;
  }

  // Authenticate before taking the sync advisory lock, matching sync routes'
  // lock order. keyed() rechecks token/device liveness inside the transaction.
  async function withCaller(req: FastifyRequest, reply: FastifyReply, write: boolean,
    run: (tx: Db, caller: Caller) => Promise<unknown>) {
    const caller = await guard(db, req, reply, write);
    if (!caller) return;
    return db.transaction((tx) => run(tx, caller));
  }

  app.get("/v1/fleet", async (req, reply) => withCaller(req, reply, false, async (tx, caller) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
    const epoch = await unlocked(tx, caller, reply);
    if (epoch === null) return;
    const { rows } = await tx.query<ComputerRow>(
      `select f.device_id, f.key_id, f.revision, f.descriptor, f.seen_at,
              f.seen_at + make_interval(secs => ${FLEET_LEASE_SECONDS}) as expires_at,
              f.seen_at > now() - make_interval(secs => ${FLEET_LEASE_SECONDS}) as online
         from fleet_computers f
         join sync_devices d on d.id = f.device_id and d.user_id = f.user_id
         join api_tokens t on t.id = f.token_id and t.user_id = f.user_id and t.device_id = f.device_id
         join sync_key_wraps w on w.user_id = f.user_id and w.device_id = f.device_id and w.key_id = f.key_id
        where f.user_id = $1 and f.key_id = $2 and not f.withdrawn and d.revoked_at is null
          and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
          and t.sync_proven_key_id = f.key_id
        order by f.device_id limit ${MAX_FLEET_COMPUTERS}`,
      [caller.userId, epoch],
    );
    return { keyId: epoch, computers: rows.map(wire) };
  }));

  // Identity comes only from the authenticated token: no body/path device id.
  app.put("/v1/fleet/self", { bodyLimit: 24 * 1024 }, async (req, reply) => withCaller(req, reply, true, async (tx, caller) => {
    // Same lock as key rotation; never publish an old epoch over a new one.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
    const epoch = await unlocked(tx, caller, reply);
    if (epoch === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const descriptor = bytes(body.descriptor, MIN_DESCRIPTOR_BYTES, MAX_DESCRIPTOR_BYTES);
    if (!descriptor || descriptor[0] !== 1 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
      || Object.keys(body).some((k) => !["keyId", "revision", "descriptor"].includes(k))) {
      return reply.code(400).send({ error: "bad-descriptor" });
    }
    if (body.keyId !== epoch) return reply.code(409).send({ error: "key-epoch", currentKeyId: epoch });
    const { rows } = await tx.query<{ revision: string }>(
      "select revision from fleet_computers where user_id = $1 and device_id = $2", [caller.userId, caller.deviceId],
    );
    const previous = Number(rows[0]?.revision ?? 0);
    if (Number(body.revision) !== previous + 1) return reply.code(409).send({ error: "revision", currentRevision: previous });
    if (!rows.length) {
      const count = await tx.query<{ n: number }>("select count(*)::int as n from fleet_computers where user_id = $1", [caller.userId]);
      if (count.rows[0].n >= MAX_FLEET_COMPUTERS) return reply.code(409).send({ error: "fleet-full" });
    }
    await tx.query(
      `insert into fleet_computers (user_id, device_id, token_id, key_id, revision, descriptor)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (device_id) do update set token_id = excluded.token_id, key_id = excluded.key_id,
         revision = excluded.revision, descriptor = excluded.descriptor, seen_at = now(), withdrawn = false`,
      [caller.userId, caller.deviceId, caller.tokenId, epoch, body.revision, descriptor],
    );
    return reply.code(rows.length ? 200 : 201).send({ deviceId: caller.deviceId, keyId: epoch, revision: body.revision, leaseSeconds: FLEET_LEASE_SECONDS });
  }));

  app.post("/v1/fleet/self/heartbeat", async (req, reply) => withCaller(req, reply, true, async (tx, caller) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
    const epoch = await unlocked(tx, caller, reply);
    if (epoch === null) return;
    const { rows } = await tx.query(
      `update fleet_computers set seen_at = now()
        where user_id = $1 and device_id = $2 and token_id = $3 and key_id = $4 and not withdrawn
        returning device_id`, [caller.userId, caller.deviceId, caller.tokenId, epoch],
    );
    if (!rows.length) return reply.code(409).send({ error: "publish-required" });
    return { leaseSeconds: FLEET_LEASE_SECONDS };
  }));

  // Removing one's own advertisement never requires a paid plan or unlocked
  // keys. Retain the revision guard so a stale publish cannot resurrect it.
  app.delete("/v1/fleet/self", async (req, reply) => withCaller(req, reply, false, async (tx, caller) => {
    if (!caller.deviceId) return reply.code(403).send({ error: "needs-device" });
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${caller.userId}`]);
    await tx.query("update fleet_computers set withdrawn = true, revision = least(revision + 1, 9007199254740991) where user_id = $1 and device_id = $2 and not withdrawn", [caller.userId, caller.deviceId]);
    return reply.code(204).send();
  }));
}
