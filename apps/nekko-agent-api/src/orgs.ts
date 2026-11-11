import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import { FLEET_LEASE_SECONDS, MAX_DESCRIPTOR_BYTES } from "./fleet.js";
import { bytes, currentKeyId, keyed } from "./sync.js";

/**
 * Organizations own a shared computer fleet (docs/decisions/0086). The server
 * keeps who belongs to an org, the org's key epoch number (never key material)
 * and sealed computer descriptors. A fleet row is discovery, never access to a
 * computer. Off unless `orgsEnabled`; `allowedEmails` narrows who may create
 * orgs, accept invites or use the org fleet while the feature is being proven.
 */
export const MAX_ORGS_PER_USER = 20;
export const MAX_ORG_MEMBERS = 100;
export const MAX_ORG_COMPUTERS = 100;
const MIN_DESCRIPTOR_BYTES = 1 + 32 + 256 + 16; // nekko-sync v1 padded sealed record
const MAX_KEY_EPOCH = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface OrgsOptions {
  /** Lower-case emails; when non-empty only these accounts may create orgs, accept invites or use the org fleet. */
  allowedEmails?: string[];
}

type Role = "owner" | "admin" | "member";

interface OrgRow {
  id: string;
  name: string;
  role: Role;
  key_id: number;
  member_count: number;
  created_at: Date;
}

const orgWire = (r: OrgRow) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  keyId: r.key_id,
  memberCount: r.member_count,
  createdAt: r.created_at,
});

interface ComputerRow {
  device_id: string;
  user_id: string;
  org_key_id: number;
  revision: string;
  descriptor: Buffer;
  seen_at: Date;
  expires_at: Date;
  online: boolean;
}

const ORG_SELECT = `select o.id, o.name, m.role, o.key_id, o.created_at,
        (select count(*)::int from org_members c where c.org_id = o.id) as member_count
   from orgs o join org_members m on m.org_id = o.id`;

const lockUser = (tx: Db, userId: string) => tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${userId}`]);
const lockOrg = (tx: Db, orgId: string) => tx.query("select pg_advisory_xact_lock(hashtext($1))", [`org:${orgId}`]);

const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 400 || CONTROL.test(v.replace(/\s/g, " "))) return null;
  const name = v.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
};

const cleanEmail = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && EMAIL.test(email) ? email : null;
};

type Gate = "none" | "allowlist";
type Lock = "none" | "user" | "org";

interface RouteOptions {
  /** `allowlist` applies NEKKO_ORGS_ALLOWED_EMAILS. */
  gate: Gate;
  /** Publishing and creating need a sync plan; everything else works on any plan. */
  write?: boolean;
  /** `org` takes the user lock, then the org lock (always in that order). */
  lock: Lock;
}

export function registerOrgs(app: FastifyInstance, db: Db, opts: OrgsOptions = {}): void {
  const allowed = new Set((opts.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));

  async function emailOf(tx: Db, userId: string): Promise<string> {
    const { rows } = await tx.query<{ email: string }>("select lower(email) as email from users where id = $1", [userId]);
    return rows[0]?.email ?? "";
  }

  /** Authenticates, applies the allowlist and plan, takes locks, then runs the handler in one transaction. */
  async function handle(
    req: FastifyRequest,
    reply: FastifyReply,
    o: RouteOptions,
    run: (tx: Db, caller: Caller, orgId: string, email: () => Promise<string>) => Promise<unknown>,
  ) {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    const orgId = String((req.params as Record<string, unknown> | undefined)?.orgId ?? "");
    if (orgId && !UUID.test(orgId)) return reply.code(404).send({ error: "not-found" });
    if (o.gate === "allowlist" && allowed.size && !allowed.has(await emailOf(db, caller.userId))) {
      return reply.code(403).send({ error: "orgs-not-available" });
    }
    if (o.write && !SYNC_PLANS.has(caller.plan)) {
      return reply.code(402).send({ error: "plan-required", plan: caller.plan, needs: ["pro", "team"] });
    }
    return db.transaction(async (tx) => {
      if (o.lock !== "none") await lockUser(tx, caller.userId);
      if (o.lock === "org" && orgId) await lockOrg(tx, orgId);
      let cached: string | undefined;
      const email = async () => (cached ??= await emailOf(tx, caller.userId));
      return run(tx, caller, orgId, email);
    });
  }

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not-found" });
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "forbidden" });

  async function membership(tx: Db, orgId: string, userId: string): Promise<{ role: Role; keyId: number } | null> {
    const { rows } = await tx.query<{ role: Role; key_id: number }>(
      "select m.role, o.key_id from org_members m join orgs o on o.id = m.org_id where m.org_id = $1 and m.user_id = $2",
      [orgId, userId],
    );
    return rows[0] ? { role: rows[0].role, keyId: rows[0].key_id } : null;
  }

  async function orgFor(tx: Db, orgId: string, userId: string): Promise<ReturnType<typeof orgWire> | null> {
    const { rows } = await tx.query<OrgRow>(`${ORG_SELECT} where o.id = $1 and m.user_id = $2`, [orgId, userId]);
    return rows[0] ? orgWire(rows[0]) : null;
  }

  /** The same check the account fleet uses: a live device holding the account's current epoch. */
  async function unlocked(tx: Db, caller: Caller, reply: FastifyReply): Promise<boolean> {
    const epoch = await currentKeyId(tx, caller.userId);
    if (epoch === null || !(await keyed(tx, caller, epoch))) {
      reply.code(403).send({ error: "needs-synced-device" });
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- orgs

  app.get("/v1/orgs", async (req, reply) => handle(req, reply, { gate: "none", lock: "none" }, async (tx, caller, _o, email) => {
    const orgs = await tx.query<OrgRow>(`${ORG_SELECT} where m.user_id = $1 order by o.created_at, o.id`, [caller.userId]);
    const invites = await tx.query<{ id: string; org_id: string; org_name: string; role: string; invited_by: string; expires_at: Date }>(
      `select i.id, i.org_id, o.name as org_name, i.role, coalesce(u.email, '') as invited_by, i.expires_at
         from org_invites i join orgs o on o.id = i.org_id left join users u on u.id = i.invited_by
        where i.email = $1 and i.accepted_at is null and i.expires_at > now()
        order by i.created_at, i.id`,
      [await email()],
    );
    return {
      orgs: orgs.rows.map(orgWire),
      invites: invites.rows.map((i) => ({ id: i.id, orgId: i.org_id, orgName: i.org_name, role: i.role, invitedBy: i.invited_by, expiresAt: i.expires_at })),
    };
  }));

  app.post("/v1/orgs", async (req, reply) => handle(req, reply, { gate: "allowlist", write: true, lock: "user" }, async (tx, caller) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = cleanName(body.name);
    if (!name) return reply.code(400).send({ error: "bad-name" });
    const count = await tx.query<{ n: number }>("select count(*)::int as n from org_members where user_id = $1", [caller.userId]);
    if (count.rows[0].n >= MAX_ORGS_PER_USER) return reply.code(409).send({ error: "org-limit" });
    const created = await tx.query<{ id: string }>("insert into orgs (name, created_by) values ($1, $2) returning id", [name, caller.userId]);
    await tx.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [created.rows[0].id, caller.userId]);
    return reply.code(201).send(await orgFor(tx, created.rows[0].id, caller.userId));
  }));

  app.get("/v1/orgs/:orgId", async (req, reply) => handle(req, reply, { gate: "none", lock: "none" }, async (tx, caller, orgId) => {
    const org = await orgFor(tx, orgId, caller.userId);
    if (!org) return notFound(reply);
    const members = await tx.query<{ user_id: string; email: string; role: Role; added_at: Date }>(
      `select m.user_id, u.email, m.role, m.added_at from org_members m join users u on u.id = m.user_id
        where m.org_id = $1 order by m.added_at, m.user_id`,
      [orgId],
    );
    let invites: { id: string; email: string; role: string; createdAt: Date; expiresAt: Date }[] = [];
    if (org.role !== "member") {
      const rows = await tx.query<{ id: string; email: string; role: string; created_at: Date; expires_at: Date }>(
        `select id, email, role, created_at, expires_at from org_invites
          where org_id = $1 and accepted_at is null and expires_at > now() order by created_at, id`,
        [orgId],
      );
      invites = rows.rows.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at }));
    }
    return {
      ...org,
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, role: m.role, addedAt: m.added_at, you: m.user_id === caller.userId })),
      invites,
    };
  }));

  app.patch("/v1/orgs/:orgId", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (m.role === "member") return forbidden(reply);
    const name = cleanName(((req.body ?? {}) as Record<string, unknown>).name);
    if (!name) return reply.code(400).send({ error: "bad-name" });
    await tx.query("update orgs set name = $2 where id = $1", [orgId, name]);
    return orgFor(tx, orgId, caller.userId);
  }));

  app.delete("/v1/orgs/:orgId", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (m.role !== "owner") return forbidden(reply);
    await tx.query("delete from orgs where id = $1", [orgId]);
    return reply.code(204).send();
  }));

  // ------------------------------------------------------------- invites

  app.post("/v1/orgs/:orgId/invites", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (m.role === "member") return forbidden(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = cleanEmail(body.email);
    if (!email) return reply.code(400).send({ error: "bad-email" });
    const role = body.role ?? "member";
    if (role !== "admin" && role !== "member") return reply.code(400).send({ error: "bad-role" });
    const already = await tx.query(
      "select 1 from org_members m join users u on u.id = m.user_id where m.org_id = $1 and lower(u.email) = $2", [orgId, email],
    );
    if (already.rows.length) return reply.code(409).send({ error: "already-member" });
    await tx.query("delete from org_invites where org_id = $1 and email = $2 and accepted_at is null and expires_at <= now()", [orgId, email]);
    const pending = await tx.query("select 1 from org_invites where org_id = $1 and email = $2 and accepted_at is null", [orgId, email]);
    if (pending.rows.length) return reply.code(409).send({ error: "invite-exists" });
    const load = await tx.query<{ n: number }>(
      `select ((select count(*) from org_members where org_id = $1)
             + (select count(*) from org_invites where org_id = $1 and accepted_at is null and expires_at > now()))::int as n`,
      [orgId],
    );
    if (load.rows[0].n >= MAX_ORG_MEMBERS) return reply.code(409).send({ error: "org-full" });
    const { rows } = await tx.query<{ id: string; created_at: Date; expires_at: Date }>(
      "insert into org_invites (org_id, email, role, invited_by) values ($1, $2, $3, $4) returning id, created_at, expires_at",
      [orgId, email, role, caller.userId],
    );
    return reply.code(201).send({ id: rows[0].id, email, role, createdAt: rows[0].created_at, expiresAt: rows[0].expires_at });
  }));

  app.delete("/v1/orgs/:orgId/invites/:inviteId", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (m.role === "member") return forbidden(reply);
    const { inviteId } = req.params as { inviteId: string };
    if (!UUID.test(inviteId)) return notFound(reply);
    const { rows } = await tx.query("delete from org_invites where id = $1 and org_id = $2 and accepted_at is null returning id", [inviteId, orgId]);
    return rows.length ? reply.code(204).send() : notFound(reply);
  }));

  app.post("/v1/orgs/invites/:inviteId/accept", async (req, reply) => handle(req, reply, { gate: "allowlist", lock: "user" }, async (tx, caller, _o, email) => {
    const { inviteId } = req.params as { inviteId: string };
    if (!UUID.test(inviteId)) return notFound(reply);
    // The invite is addressed to an email, so a mismatch looks like a missing invite.
    const mine = await email();
    const peek = await tx.query<{ org_id: string }>("select org_id from org_invites where id = $1 and email = $2 and accepted_at is null", [inviteId, mine]);
    if (!peek.rows.length) return notFound(reply);
    const orgId = peek.rows[0].org_id;
    await lockOrg(tx, orgId);
    const { rows } = await tx.query<{ role: "admin" | "member"; expired: boolean }>(
      "select role, expires_at <= now() as expired from org_invites where id = $1 and org_id = $2 and email = $3 and accepted_at is null",
      [inviteId, orgId, mine],
    );
    if (!rows.length) return notFound(reply);
    if (rows[0].expired) return reply.code(410).send({ error: "invite-expired" });
    const existing = await membership(tx, orgId, caller.userId);
    if (!existing) {
      const joined = await tx.query<{ n: number }>("select count(*)::int as n from org_members where user_id = $1", [caller.userId]);
      if (joined.rows[0].n >= MAX_ORGS_PER_USER) return reply.code(409).send({ error: "org-limit" });
      const size = await tx.query<{ n: number }>("select count(*)::int as n from org_members where org_id = $1", [orgId]);
      if (size.rows[0].n >= MAX_ORG_MEMBERS) return reply.code(409).send({ error: "org-full" });
      await tx.query("insert into org_members (org_id, user_id, role) values ($1, $2, $3)", [orgId, caller.userId, rows[0].role]);
    }
    await tx.query("update org_invites set accepted_at = now() where id = $1", [inviteId]);
    return orgFor(tx, orgId, caller.userId);
  }));

  // ------------------------------------------------------------- members

  // Removing a member (or leaving) does not rotate the org key here: the
  // server never holds key material. It tells the client to.
  app.delete("/v1/orgs/:orgId/members/:userId", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    const rawUser = (req.params as { userId: string }).userId;
    if (!UUID.test(rawUser)) return notFound(reply);
    const userId = rawUser.toLowerCase();
    const target = userId === caller.userId ? m : await membership(tx, orgId, userId);
    if (!target) return notFound(reply);
    if (userId !== caller.userId && (m.role === "member" || (m.role === "admin" && target.role !== "member"))) return forbidden(reply);
    if (target.role === "owner") {
      const owners = await tx.query<{ n: number }>("select count(*)::int as n from org_members where org_id = $1 and role = 'owner'", [orgId]);
      if (owners.rows[0].n <= 1) return reply.code(409).send({ error: "last-owner" });
    }
    await tx.query("delete from org_fleet_computers where org_id = $1 and user_id = $2", [orgId, userId]);
    await tx.query("delete from org_members where org_id = $1 and user_id = $2", [orgId, userId]);
    return { rotateKey: true };
  }));

  // ------------------------------------------------------------- org key

  // Advance the org-key epoch by one. The server records only the number.
  app.put("/v1/orgs/:orgId/key", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (m.role === "member") return forbidden(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(body.keyId) || Number(body.keyId) < 1 || Number(body.keyId) > MAX_KEY_EPOCH
      || Object.keys(body).some((k) => !["keyId", "proof"].includes(k))) {
      return reply.code(400).send({ error: "bad-key" });
    }
    if (!(await unlocked(tx, caller, reply))) return;
    if (body.keyId !== m.keyId + 1) return reply.code(409).send({ error: "org-key-epoch", currentKeyId: m.keyId });
    await tx.query("update orgs set key_id = $2 where id = $1", [orgId, body.keyId]);
    return { keyId: body.keyId };
  }));

  // ---------------------------------------------------------- org fleet

  // Sign-in alone is not enough here either (decision 0066): members must
  // also be unlocked on a live, proven device.
  app.get("/v1/orgs/:orgId/fleet", async (req, reply) => handle(req, reply, { gate: "allowlist", lock: "user" }, async (tx, caller, orgId) => {
    const m = await membership(tx, orgId, caller.userId);
    if (!m) return notFound(reply);
    if (!(await unlocked(tx, caller, reply))) return;
    const { rows } = await tx.query<ComputerRow>(
      `select f.device_id, f.user_id, f.org_key_id, f.revision, f.descriptor, f.seen_at,
              f.seen_at + make_interval(secs => ${FLEET_LEASE_SECONDS}) as expires_at,
              f.seen_at > now() - make_interval(secs => ${FLEET_LEASE_SECONDS}) as online
         from org_fleet_computers f
         join orgs o on o.id = f.org_id and o.key_id = f.org_key_id
         join org_members pm on pm.org_id = f.org_id and pm.user_id = f.user_id
         join sync_devices d on d.id = f.device_id and d.user_id = f.user_id
         join api_tokens t on t.id = f.token_id and t.user_id = f.user_id and t.device_id = f.device_id
         join sync_key_wraps w on w.user_id = f.user_id and w.device_id = f.device_id
        where f.org_id = $1 and not f.withdrawn and d.revoked_at is null
          and w.key_id = (select max(k.key_id) from sync_keyrings k where k.user_id = f.user_id)
          and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
          and t.sync_proven_key_id = w.key_id
        order by f.device_id limit ${MAX_ORG_COMPUTERS}`,
      [orgId],
    );
    return {
      orgKeyId: m.keyId,
      computers: rows.map((r) => ({
        deviceId: r.device_id,
        userId: r.user_id,
        orgKeyId: r.org_key_id,
        revision: Number(r.revision),
        descriptor: Buffer.from(r.descriptor).toString("base64url"),
        seenAt: r.seen_at,
        expiresAt: r.expires_at,
        online: r.online,
        you: r.device_id === caller.deviceId,
      })),
    };
  }));

  // Identity (device, user, token) comes only from the authenticated token.
  app.put("/v1/orgs/:orgId/fleet/self", { bodyLimit: 24 * 1024 }, async (req, reply) =>
    handle(req, reply, { gate: "allowlist", write: true, lock: "org" }, async (tx, caller, orgId) => {
      const m = await membership(tx, orgId, caller.userId);
      if (!m) return notFound(reply);
      if (!(await unlocked(tx, caller, reply))) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const descriptor = bytes(body.descriptor, MIN_DESCRIPTOR_BYTES, MAX_DESCRIPTOR_BYTES);
      if (!descriptor || descriptor[0] !== 1 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
        || !Number.isSafeInteger(body.orgKeyId) || Number(body.orgKeyId) < 1
        || Object.keys(body).some((k) => !["orgKeyId", "revision", "descriptor"].includes(k))) {
        return reply.code(400).send({ error: "bad-descriptor" });
      }
      if (body.orgKeyId !== m.keyId) return reply.code(409).send({ error: "org-key-epoch", currentKeyId: m.keyId });
      const { rows } = await tx.query<{ revision: string }>(
        "select revision from org_fleet_computers where org_id = $1 and device_id = $2", [orgId, caller.deviceId],
      );
      const previous = Number(rows[0]?.revision ?? 0);
      if (Number(body.revision) !== previous + 1) return reply.code(409).send({ error: "revision", currentRevision: previous });
      if (!rows.length) {
        const count = await tx.query<{ n: number }>("select count(*)::int as n from org_fleet_computers where org_id = $1", [orgId]);
        if (count.rows[0].n >= MAX_ORG_COMPUTERS) return reply.code(409).send({ error: "fleet-full" });
      }
      await tx.query(
        `insert into org_fleet_computers (org_id, device_id, user_id, token_id, org_key_id, revision, descriptor)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (org_id, device_id) do update set token_id = excluded.token_id, org_key_id = excluded.org_key_id,
           revision = excluded.revision, descriptor = excluded.descriptor, seen_at = now(), withdrawn = false`,
        [orgId, caller.deviceId, caller.userId, caller.tokenId, m.keyId, body.revision, descriptor],
      );
      return reply.code(rows.length ? 200 : 201).send({ deviceId: caller.deviceId, orgKeyId: m.keyId, revision: body.revision, leaseSeconds: FLEET_LEASE_SECONDS });
    }));

  app.post("/v1/orgs/:orgId/fleet/self/heartbeat", async (req, reply) =>
    handle(req, reply, { gate: "allowlist", write: true, lock: "org" }, async (tx, caller, orgId) => {
      const m = await membership(tx, orgId, caller.userId);
      if (!m) return notFound(reply);
      if (!(await unlocked(tx, caller, reply))) return;
      const { rows } = await tx.query(
        `update org_fleet_computers set seen_at = now()
          where org_id = $1 and user_id = $2 and device_id = $3 and token_id = $4 and org_key_id = $5 and not withdrawn
          returning device_id`,
        [orgId, caller.userId, caller.deviceId, caller.tokenId, m.keyId],
      );
      if (!rows.length) return reply.code(409).send({ error: "publish-required" });
      return { leaseSeconds: FLEET_LEASE_SECONDS };
    }));

  // Withdrawing one's own advertisement needs no paid plan, no unlocked keys
  // and is not held back by the allowlist. The revision guard stays so a stale
  // publish cannot resurrect it.
  app.delete("/v1/orgs/:orgId/fleet/self", async (req, reply) => handle(req, reply, { gate: "none", lock: "org" }, async (tx, caller, orgId) => {
    if (!caller.deviceId) return reply.code(403).send({ error: "needs-device" });
    if (!(await membership(tx, orgId, caller.userId))) return notFound(reply);
    await tx.query(
      `update org_fleet_computers set withdrawn = true, revision = least(revision + 1, 9007199254740991)
        where org_id = $1 and user_id = $2 and device_id = $3 and not withdrawn`,
      [orgId, caller.userId, caller.deviceId],
    );
    return reply.code(204).send();
  }));
}
