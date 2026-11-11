import type { FastifyInstance } from "fastify";
import { authenticate, issueToken, type Plan, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import type { MachineDriver } from "./fly.js";
import { emailHash } from "./retention.js";
import { type DeleteAuthUser, InvalidSession, type SupabaseIdentity, type VerifyAccessToken } from "./supabase.js";

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

/** What deleting an account reaches beyond this database. */
export interface AccountDeletion {
  /** Destroys cloud machines; without it an account with a live machine can't be deleted. */
  driver?: MachineDriver;
  /** Deletes the Supabase Auth user; without it the deletion waits in pending_auth_deletions. */
  deleteAuthUser?: DeleteAuthUser;
}

export class MachineTeardownFailed extends Error {}

/**
 * Deletes an account for good (decision 0043). First every cloud machine the
 * account ever had is destroyed on Fly, so nothing keeps running or billing
 * and the pairing key in its environment goes with it; if one can't be, this
 * throws MachineTeardownFailed and deletes nothing. Then, in one transaction:
 * the address goes on the suppression list, its signup rows are deleted, the
 * Supabase user is queued for deletion, and the users row is deleted, which
 * cascades to tokens, sync data, machine rows and machine hours.
 * Returns the Supabase subject still to delete, if any.
 */
export async function deleteAccount(db: Db, userId: string, del: AccountDeletion): Promise<string | null> {
  const { rows: machines } = await db.query<{ provider_ref: string; deleted_at: Date | null }>(
    "select provider_ref, deleted_at from cloud_machines where user_id = $1 and provider_ref is not null",
    [userId],
  );
  for (const m of machines) {
    // A machine deleted earlier is destroyed again: that delete ignored Fly's errors.
    if (!del.driver) {
      if (!m.deleted_at) throw new MachineTeardownFailed("cloud machines are not configured");
      continue;
    }
    try {
      await del.driver.destroy(m.provider_ref);
    } catch (e) {
      throw new MachineTeardownFailed(String(e).slice(0, 200));
    }
  }
  // shortcut: a machine created by another request between the teardown and this transaction is orphaned on Fly; lock creation per user if that ever happens.
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ email: string; auth_subject: string | null }>("select email, auth_subject from users where id = $1 for update", [userId]);
    const user = rows[0];
    if (!user) return null;
    // Orgs this account alone owns go with it; everywhere else its membership and
    // computers cascade. Same lock order as the org routes: user, then each org.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync:${userId}`]);
    const sole = await tx.query<{ org_id: string }>(
      `select m.org_id from org_members m where m.user_id = $1 and m.role = 'owner'
          and not exists (select 1 from org_members o where o.org_id = m.org_id and o.role = 'owner' and o.user_id <> $1)
        order by m.org_id`,
      [userId],
    );
    for (const { org_id } of sole.rows) await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`org:${org_id}`]);
    if (sole.rows.length) await tx.query("delete from orgs where id = any($1::uuid[])", [sole.rows.map((r) => r.org_id)]);
    await tx.query("delete from org_invites where email = lower($1)", [user.email]);
    await tx.query("insert into email_suppressions (email_hash) values ($1) on conflict do nothing", [emailHash(user.email)]);
    await tx.query("delete from signups where user_id = $1 or lower(email) = lower($2)", [userId, user.email]);
    if (user.auth_subject) await tx.query("insert into pending_auth_deletions (auth_subject) values ($1) on conflict do nothing", [user.auth_subject]);
    await tx.query("delete from users where id = $1", [userId]);
    return user.auth_subject;
  });
}

/**
 * Deletes queued Supabase Auth users (one, or every one queued). A failure
 * leaves the row for the next run and is logged without the user. Returns how
 * many are still queued among those tried.
 */
export async function retryAuthDeletions(db: Db, deleteAuthUser: DeleteAuthUser | undefined, subject?: string): Promise<number> {
  const { rows } = subject
    ? await db.query<{ auth_subject: string }>("select auth_subject from pending_auth_deletions where auth_subject = $1", [subject])
    : await db.query<{ auth_subject: string }>("select auth_subject from pending_auth_deletions order by created_at", []);
  if (!deleteAuthUser) {
    if (rows.length) console.warn(`SUPABASE_SERVICE_ROLE_KEY not set: ${rows.length} Supabase user deletion(s) waiting`);
    return rows.length;
  }
  let left = 0;
  for (const { auth_subject } of rows) {
    try {
      await deleteAuthUser(auth_subject);
      await db.query("delete from pending_auth_deletions where auth_subject = $1", [auth_subject]);
    } catch (e) {
      left++;
      console.error("Supabase user deletion failed, will retry:", String((e as Error).message ?? e).slice(0, 200));
    }
  }
  return left;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

export function registerAccount(
  app: FastifyInstance,
  db: Db,
  signIn: SignInConfig | undefined,
  signInLimit: { max: number; timeWindow: number },
  deletion: AccountDeletion = {},
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

  // Delete the account and everything it holds here (decision 0043). 502
  // when a cloud machine couldn't be destroyed: then nothing was deleted and
  // the app can try again. The Supabase user goes after the local delete; a
  // failure there is retried in the background and still answers 204.
  app.delete("/v1/account", async (req, reply) => {
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    let subject: string | null;
    try {
      subject = await deleteAccount(db, caller.userId, deletion);
    } catch (e) {
      if (!(e instanceof MachineTeardownFailed)) throw e;
      req.log.error({ err: e.message }, "account deletion stopped: a cloud machine could not be destroyed");
      return reply.code(502).send({ error: "machine-teardown-failed" });
    }
    if (subject) await retryAuthDeletions(db, deletion.deleteAuthUser, subject);
    return reply.code(204).send();
  });
}
