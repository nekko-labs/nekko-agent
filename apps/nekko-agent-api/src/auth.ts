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

/**
 * Which accounts may use Nekko Cloud at all (issue #2932). Both lists are
 * lower-case; when both are empty everyone may. A domain matches the part
 * after the last "@" exactly, so "nekkolabs.com" does not admit
 * "x@mail.nekkolabs.com" or "x@evilnekkolabs.com".
 */
export interface AccountGate {
  domains: ReadonlySet<string>;
  emails: ReadonlySet<string>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Set by buildServer when NEKKO_ACCOUNTS_ALLOWED_DOMAINS / _EMAILS is non-empty. */
    accountGate?: AccountGate;
  }
}

/** Comma-separated list (as in the environment) to a lower-cased, trimmed set. */
export const parseList = (v: string | undefined): string[] => (v ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export function accountGateFrom(domains: readonly string[] = [], emails: readonly string[] = []): AccountGate | undefined {
  const clean = (l: readonly string[]) => new Set(l.map((e) => e.trim().toLowerCase().replace(/^@/, "")).filter(Boolean));
  const gate = { domains: clean(domains), emails: clean(emails) };
  return gate.domains.size || gate.emails.size ? gate : undefined;
}

/** Whether a proven email passes the gate; no gate lets everyone in. */
export function accountAllowed(gate: AccountGate | undefined, email: string | null | undefined, verified = true): boolean {
  if (!gate) return true;
  if (!verified || !email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return gate.emails.has(e) || (at > 0 && gate.domains.has(e.slice(at + 1)));
}

const TOKEN = /^nk_[A-Za-z0-9_-]{43}$/;

const hash = (token: string) => createHash("sha256").update(token).digest();

/** How long a token lasts after its last use. */
export const TOKEN_IDLE_DAYS = 180;

/**
 * Issues a bearer token for a user (one per signed-in device). Only its
 * SHA-256 is stored, so a database leak doesn't hand out sessions.
 */
export async function issueToken(db: Db, userId: string, label: string | null = null): Promise<string> {
  const token = `nk_${randomBytes(32).toString("base64url")}`;
  await db.query(
    `insert into api_tokens (user_id, token_hash, label, expires_at) values ($1, $2, $3, now() + make_interval(days => ${TOKEN_IDLE_DAYS}))`,
    [userId, hash(token), label],
  );
  return token;
}

/**
 * The caller behind `Authorization: Bearer nk_…`, or null.
 *
 * A read on the hot path. `last_used_at` and the sliding `expires_at` are
 * written only when `last_used_at` is older than the current hour, so a busy
 * token costs one write an hour instead of one per request. Nothing else reads
 * `last_used_at` (it is the hour the token was last seen, kept for the
 * account's own records), and the expiry moves by under an hour from what it
 * was, against a 180-day idle limit.
 */
export async function authenticate(db: Db, req: FastifyRequest): Promise<Caller | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!TOKEN.test(token)) return null;
  const digest = hash(token);
  const { rows } = await db.query<{ id: string; user_id: string; plan: Plan; device_id: string | null; email: string; email_verified: boolean; stale: boolean }>(
    `select t.id, t.user_id, u.plan, t.device_id, u.email, u.email_verified,
            (t.last_used_at is null or t.last_used_at < date_trunc('hour', now())) as stale
       from api_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked_at is null
        and (t.expires_at is null or t.expires_at > now())`,
    [digest],
  );
  const row = rows[0];
  if (!row) return null;
  // The account gate: the email comes from the same lookup, so no extra query. An account whose email was never proven is outside it.
  if (!accountAllowed(req.server.accountGate, row.email, row.email_verified)) return null;
  if (row.stale) {
    // Re-checked in the update, so two requests in the same hour boundary write once.
    await db.query(
      `update api_tokens set last_used_at = date_trunc('hour', now()), expires_at = now() + make_interval(days => ${TOKEN_IDLE_DAYS})
        where id = $1 and (last_used_at is null or last_used_at < date_trunc('hour', now()))`,
      [row.id],
    );
  }
  return { userId: row.user_id, plan: row.plan, tokenId: row.id, deviceId: row.device_id };
}
