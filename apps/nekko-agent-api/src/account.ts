import type { FastifyInstance } from "fastify";
import { authenticate, issueToken, type Plan, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import { InvalidSession, type SupabaseIdentity, type VerifyAccessToken } from "./supabase.js";

export interface SignInConfig {
  /** Public: the app signs in to Supabase Auth with these. */
  supabaseUrl: string;
  supabaseAnonKey: string;
  verify: VerifyAccessToken;
}

interface UserRow {
  id: string;
  email: string;
  plan: Plan;
  auth_subject: string | null;
}

const account = (u: UserRow) => ({ id: u.id, email: u.email, plan: u.plan, canSync: SYNC_PLANS.has(u.plan) });

export class AccountConflict extends Error {}

/**
 * The user for a verified Supabase identity: found by its subject; else a
 * user row with the same email and no subject yet (a beta signup let in) is
 * linked; else a new free account. Supabase only issues sessions for
 * confirmed emails, so the email is proven.
 */
export async function userForIdentity(db: Db, id: SupabaseIdentity): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const bySubject = await tx.query<UserRow>("select id, email, plan, auth_subject from users where auth_subject = $1", [id.subject]);
    if (bySubject.rows[0]) {
      const u = bySubject.rows[0];
      if (id.emailVerified && u.email.toLowerCase() !== id.email.toLowerCase()) {
        // The user changed their email in Supabase; follow it unless another account holds it.
        const taken = await tx.query("select 1 from users where lower(email) = lower($1) and id <> $2", [id.email, u.id]);
        if (!taken.rows.length) {
          await tx.query("update users set email = $1, updated_at = now() where id = $2", [id.email, u.id]);
          u.email = id.email;
        }
      }
      return u;
    }
    const byEmail = await tx.query<UserRow>("select id, email, plan, auth_subject from users where lower(email) = lower($1)", [id.email]);
    let user = byEmail.rows[0];
    if (user && user.auth_subject && user.auth_subject !== id.subject) {
      // Another Supabase user already owns this email's account (e.g. the auth user was deleted and recreated).
      throw new AccountConflict("This email belongs to another sign-in. Contact support.");
    }
    if (user && !id.emailVerified) {
      // An unproven email can't take over an account someone made with it (a paid beta signup, say).
      throw new AccountConflict("Confirm your email address, then sign in again.");
    }
    if (user) {
      await tx.query("update users set auth_subject = $1, updated_at = now() where id = $2", [id.subject, user.id]);
      user.auth_subject = id.subject;
    } else {
      const ins = await tx.query<UserRow>(
        "insert into users (email, auth_subject) values ($1, $2) returning id, email, plan, auth_subject",
        [id.email, id.subject],
      );
      user = ins.rows[0];
    }
    await tx.query(
      "update signups set user_id = $1, status = 'joined', updated_at = now() where lower(email) = lower($2) and user_id is null",
      [user.id, id.email],
    );
    return user;
  });
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

export function registerAccount(
  app: FastifyInstance,
  db: Db,
  signIn: SignInConfig | undefined,
  signInLimit: { max: number; timeWindow: number },
): void {
  // What the app needs to start a Supabase sign-in. Both values are public.
  app.get("/v1/auth/config", async (_req, reply) => {
    if (!signIn) return reply.code(503).send({ error: "sign-in-not-configured" });
    return { supabaseUrl: signIn.supabaseUrl, supabaseAnonKey: signIn.supabaseAnonKey };
  });

  // Trade a Supabase access token for this device's Nekko Cloud token. The
  // Supabase session stays on the device; the server keeps only the account.
  app.post("/v1/auth/session", { config: { rateLimit: signInLimit } }, async (req, reply) => {
    if (!signIn) return reply.code(503).send({ error: "sign-in-not-configured" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
    if (!accessToken || accessToken.length > 8192) return reply.code(400).send({ error: "accessToken is required" });
    let identity: SupabaseIdentity;
    try {
      identity = await signIn.verify(accessToken);
    } catch (e) {
      if (e instanceof InvalidSession) return reply.code(401).send({ error: "invalid-session", message: e.message });
      throw e;
    }
    try {
      const user = await userForIdentity(db, identity);
      const token = await issueToken(db, user.id, clean(body.label, 60) || null);
      return reply.code(201).send({ token, account: account(user) });
    } catch (e) {
      if (e instanceof AccountConflict) return reply.code(409).send({ error: "account-conflict", message: e.message });
      throw e;
    }
  });

  app.get("/v1/auth/me", async (req, reply) => {
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    const { rows } = await db.query<UserRow>("select id, email, plan, auth_subject from users where id = $1", [caller.userId]);
    return { account: account(rows[0]), device: caller.deviceId };
  });

  // Sign out this device: its token stops working. Its sync device and wraps
  // stay, so signing in again on the same device keeps its keys; revoking the
  // device (DELETE /v1/sync/devices/:id) is the stronger step.
  app.delete("/v1/auth/session", async (req, reply) => {
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    await db.query("update api_tokens set revoked_at = now() where id = $1", [caller.tokenId]);
    return reply.code(204).send();
  });
}
