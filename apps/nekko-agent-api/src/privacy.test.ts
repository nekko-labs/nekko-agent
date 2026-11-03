import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAuthDeletions } from "./account.js";
import { emailAlerter } from "./alerts.js";
import { issueToken } from "./auth.js";
import type { Email } from "./confirmations.js";
import type { Db } from "./db.js";
import { MemoryDriver } from "./fly.js";
import { migrate } from "./migrate.js";
import { emailHash } from "./retention.js";
import { buildServer, type ServerOptions } from "./server.js";
import { pgliteDb } from "./test-db.js";

let db: Db;
let driver: MemoryDriver;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  driver = new MemoryDriver();
});
afterEach(() => db.close());

const app = (extra: Partial<ServerOptions> = {}) =>
  buildServer({ db, allowedOrigins: [], machines: { driver, relayUrl: "wss://relay.test", image: "img" }, ...extra });
type App = ReturnType<typeof app>;
const del = (a: App, token?: string) =>
  a.inject({ method: "DELETE", url: "/v1/account", headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("request logs (GD5)", () => {
  it("hold method, path, status and timing, never the client IP or a query-string token", async () => {
    const lines: string[] = [];
    const a = buildServer({ db, allowedOrigins: [], logger: { stream: { write: (l) => void lines.push(l) } } });
    const secret = "tok3nS3cretValue";
    for (const url of [`/v1/signups/confirm?token=${secret}`, `/v1/signups/unsubscribe?token=${secret}`, `/nope?token=${secret}`]) {
      await a.inject({ method: "GET", url, remoteAddress: "203.0.113.9", headers: { "x-forwarded-for": "198.51.100.7" } });
    }
    const log = lines.join("");
    expect(log).not.toContain(secret);
    expect(log).not.toContain("203.0.113.9");
    expect(log).not.toContain("198.51.100.7");
    expect(log).not.toContain("remoteAddress");
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toContainEqual(expect.objectContaining({ req: { method: "GET", path: "/v1/signups/confirm" } }));
    expect(parsed).toContainEqual(expect.objectContaining({ res: { statusCode: 400 }, responseTime: expect.any(Number) }));
  });
});

describe("error alerting (GD8)", () => {
  it("emails at most once per 15 minutes", async () => {
    const sent: Email[] = [];
    let t = 0;
    const alert = emailAlerter(async (e) => void sent.push(e), "ops@example.com", 15 * 60 * 1000, () => t);
    alert("GET /x answered 500");
    alert("GET /x answered 500");
    t = 14 * 60 * 1000;
    alert("GET /y answered 503");
    expect(sent).toHaveLength(1);
    t = 15 * 60 * 1000;
    alert("GET /y answered 503");
    expect(sent.map((e) => [e.to, e.subject])).toEqual([
      ["ops@example.com", "Nekko Cloud alert: GET /x answered 500"],
      ["ops@example.com", "Nekko Cloud alert: GET /y answered 503"],
    ]);
  });

  it("fires on a 5xx with the route only, no body or address", async () => {
    const alert = vi.fn();
    const broken: Db = { ...db, query: async () => { throw new Error("database down"); } };
    const a = buildServer({ db: broken, allowedOrigins: [], alert });
    const res = await a.inject({ method: "POST", url: "/v1/signups", payload: { email: "ada@example.com" } });
    expect(res.statusCode).toBe(500);
    expect(alert).toHaveBeenCalledWith("POST /v1/signups answered 500");
    await a.inject({ method: "GET", url: "/healthz" });
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

/** An account with something in every table that refers to it. */
async function account(email: string, subject: string) {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan, auth_subject) values ($1, 'pro', $2) returning id", [email, subject]);
  const id = rows[0].id;
  const token = await issueToken(db, id);
  await db.query("insert into signups (email, user_id, status) values ($1, $2, 'joined')", [email, id]);
  await db.query("insert into signups (email, list) values ($1, 'other-list')", [email.toUpperCase()]);
  const dev = await db.query<{ id: string }>("insert into sync_devices (user_id, public_key, label) values ($1, $2, 'Mac') returning id", [id, randomBytes(65)]);
  await db.query("insert into sync_keyrings (user_id, key_id, recovery_wrap) values ($1, 1, $2)", [id, randomBytes(146)]);
  await db.query("insert into sync_key_wraps (user_id, key_id, device_id, wrap) values ($1, 1, $2, $3)", [id, dev.rows[0].id, randomBytes(146)]);
  await db.query("insert into sync_objects (user_id, collection, object_id, revision, key_id, blob) values ($1, 'chats', $2, 1, 1, $3)", [id, randomBytes(32).toString("base64url"), randomBytes(10)]);
  await db.query("insert into sync_usage (user_id, bytes) values ($1, 10)", [id]);
  await db.query("insert into machine_usage (user_id, period, seconds) values ($1, current_date, 60)", [id]);
  return { id, token };
}

const TABLES = ["api_tokens", "sync_devices", "sync_keyrings", "sync_key_wraps", "sync_objects", "sync_usage", "cloud_machines", "machine_usage"];
async function counts(userId: string, email: string) {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await db.query<{ n: string }>(`select count(*) as n from ${t} where user_id = $1`, [userId])).rows[0].n);
  out.users = Number((await db.query<{ n: string }>("select count(*) as n from users where id = $1", [userId])).rows[0].n);
  out.signups = Number((await db.query<{ n: string }>("select count(*) as n from signups where lower(email) = lower($1)", [email])).rows[0].n);
  return out;
}

describe("DELETE /v1/account (GD6)", () => {
  it("destroys the machines, hard-deletes everything the account holds, and leaves another account alone", async () => {
    const deleteAuthUser = vi.fn(async () => {});
    const a = app({ deleteAuthUser });
    const ada = await account("ada@example.com", "auth-ada");
    const bob = await account("bob@example.com", "auth-bob");
    for (const u of [ada, bob]) {
      const made = await a.inject({ method: "POST", url: "/v1/machines", headers: { authorization: `Bearer ${u.token}` }, payload: {} });
      expect(made.statusCode).toBe(201);
    }
    // A machine deleted earlier is destroyed again too.
    const earlier = await a.inject({ method: "POST", url: "/v1/machines", headers: { authorization: `Bearer ${ada.token}` }, payload: {} });
    await a.inject({ method: "DELETE", url: `/v1/machines/${earlier.json().machine.id}`, headers: { authorization: `Bearer ${ada.token}` } });
    driver.machines.get("m-3")!.state = "running";
    const bobBefore = await counts(bob.id, "bob@example.com");

    expect((await del(a, ada.token)).statusCode).toBe(204);

    expect(await counts(ada.id, "ada@example.com")).toEqual(Object.fromEntries([...TABLES, "users", "signups"].map((t) => [t, 0])));
    expect(driver.machines.get("m-1")!.state).toBe("gone");
    expect(driver.machines.get("m-3")!.state).toBe("gone");
    expect(driver.machines.get("m-2")!.state).toBe("running");
    expect(await counts(bob.id, "bob@example.com")).toEqual(bobBefore);
    expect(bobBefore.cloud_machines).toBe(1);
    // Not mailed again; the Supabase user is gone and nothing waits.
    expect((await db.query("select 1 from email_suppressions where email_hash = $1", [emailHash("ada@example.com")])).rows).toHaveLength(1);
    expect(deleteAuthUser).toHaveBeenCalledWith("auth-ada");
    expect((await db.query("select * from pending_auth_deletions", [])).rows).toEqual([]);
    // The token died with the account.
    expect((await del(a, ada.token)).statusCode).toBe(401);
  });

  it("answers 401 without a token", async () => {
    expect((await del(app())).statusCode).toBe(401);
  });

  it("deletes nothing and answers 502 when a machine can't be destroyed", async () => {
    const a = app();
    const ada = await account("ada@example.com", "auth-ada");
    await a.inject({ method: "POST", url: "/v1/machines", headers: { authorization: `Bearer ${ada.token}` }, payload: {} });
    const before = await counts(ada.id, "ada@example.com");
    driver.destroy = async () => { throw new Error("Fly DELETE /machines/m-1?force=true: 500"); };
    const res = await del(a, ada.token);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "machine-teardown-failed" });
    expect(await counts(ada.id, "ada@example.com")).toEqual(before);
    expect((await db.query("select * from email_suppressions", [])).rows).toEqual([]);
  });

  it("still deletes locally when Supabase fails, and the retry finishes the job", async () => {
    const a = app({ deleteAuthUser: async () => { throw new Error("Supabase admin delete answered 500"); } });
    const ada = await account("ada@example.com", "auth-ada");
    expect((await del(a, ada.token)).statusCode).toBe(204);
    expect((await counts(ada.id, "ada@example.com")).users).toBe(0);
    expect((await db.query("select auth_subject from pending_auth_deletions", [])).rows).toEqual([{ auth_subject: "auth-ada" }]);
    const ok = vi.fn(async () => {});
    expect(await retryAuthDeletions(db, ok)).toBe(0);
    expect(ok).toHaveBeenCalledWith("auth-ada");
    expect((await db.query("select * from pending_auth_deletions", [])).rows).toEqual([]);
  });
});
