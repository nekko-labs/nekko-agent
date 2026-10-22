import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export type Plan = "free" | "pro" | "team";

export interface Caller {
  userId: string;
  plan: Plan;
  tokenId: string;
  /** The sync device this token belongs to, once it has registered one. */
  deviceId: string | null;
}

/** Plans that may write synced data. Reading and deleting it never depends on the plan. */
export const SYNC_PLANS: ReadonlySet<Plan> = new Set(["pro", "team"]);

const TOKEN = /^nk_[A-Za-z0-9_-]{43}$/;

const hash = (token: string) => createHash("sha256").update(token).digest();

/**
 * Issues a bearer token for a user. Only its SHA-256 is stored, so a database
 * leak doesn't hand out sessions. The sign-in flow that calls this is not
 * built yet (accounts are PF14 step 4); tests and an operator script use it.
 */
export async function issueToken(db: Db, userId: string): Promise<string> {
  const token = `nk_${randomBytes(32).toString("base64url")}`;
  await db.query("insert into api_tokens (user_id, token_hash) values ($1, $2)", [userId, hash(token)]);
  return token;
}

/** The caller behind `Authorization: Bearer nk_…`, or null. */
export async function authenticate(db: Db, req: FastifyRequest): Promise<Caller | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!TOKEN.test(token)) return null;
  const { rows } = await db.query<{ id: string; user_id: string; plan: Plan; device_id: string | null }>(
    `update api_tokens t set last_used_at = date_trunc('hour', now())
       from users u
      where t.token_hash = $1 and t.revoked_at is null and u.id = t.user_id
      returning t.id, t.user_id, u.plan, t.device_id`,
    [hash(token)],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, plan: row.plan, tokenId: row.id, deviceId: row.device_id } : null;
}
