import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { BOOT_WINDOW_MS, DB_WRITE_MS, IDENTITY_MS, LEASE_MS, Presence } from "./presence.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));
const b64 = (n: number) => randomBytes(n).toString("base64url");
const proof = (k: number): string => vectors.epochProofs.find((p: { keyId: number }) => p.keyId === k)?.proof ?? b64(32);
const sealed = () => Buffer.concat([Buffer.from([1]), randomBytes(304)]).toString("base64url");

let base: Db;
let log: string[];
let skew: number;
let app: ReturnType<typeof buildServer>;
const recording = (): Db => {
  const rec = (db: Db): Db => ({
    query: (t, p) => { log.push(t); return db.query(t, p); },
    transaction: (fn) => db.transaction((tx) => fn(rec(tx))),
    close: () => db.close(),
  });
  return rec(base);
};
const startServer = (db: Db = recording()) => buildServer({ db, allowedOrigins: [], fleetEnabled: true, orgsEnabled: true, presence: new Presence(() => Date.now() + skew) });
beforeEach(async () => {
  base = pgliteDb(new PGlite());
  await migrate(base, undefined, { lock: false });
  log = [];
  skew = 0;
  app = startServer();
});
afterEach(async () => { await app.close(); await base.close(); });

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (token: string, method: Method, url: string, payload?: object, server = app) =>
  server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
async function account() {
  const { rows } = await base.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, 'pro', true) returning id", [`${b64(8)}@example.com`]);
  const token = await issueToken(base, rows[0].id);
  const dev = await call(token, "POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Mac" });
  const id = dev.json().deviceId as string;
  await call(token, "PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, proof: proof(1), wraps: [{ deviceId: id, wrap: vectors.wrap.blob }] });
  return { user: rows[0].id, token, id };
}
type Account = Awaited<ReturnType<typeof account>>;
async function orgWith(owner: Account, member?: Account) {
  const org = (await call(owner.token, "POST", "/v1/orgs", { name: "Team" })).json().id as string;
  await call(owner.token, "PUT", `/v1/orgs/${org}/key`, { keyId: 1 });
  if (member) {
    const email = (await base.query<{ email: string }>("select email from users where id = $1", [member.user])).rows[0].email;
    const inv = (await call(owner.token, "POST", `/v1/orgs/${org}/invites`, { email })).json().id;
    await call(member.token, "POST", `/v1/orgs/invites/${inv}/accept`);
  }
  return org;
}
const publish = (a: Account, org: string) => call(a.token, "PUT", `/v1/orgs/${org}/fleet/self`, { orgKeyId: 1, revision: 1, descriptor: sealed() });
const beat = (a: Account, org: string) => call(a.token, "POST", `/v1/orgs/${org}/fleet/self/heartbeat`);
const seen = async (a: Account, org: string) => (await call(a.token, "GET", `/v1/orgs/${org}/fleet`)).json().computers as { deviceId: string; online: boolean; seenAt: string; expiresAt: string }[];
const dbWrites = () => log.filter((q) => q.includes("update org_fleet_computers set seen_at")).length;

describe("org fleet presence in memory", () => {
  it("is online after a beat, writes the database only once, and is offline after the lease", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    expect((await publish(owner, org)).statusCode).toBe(201);
    log = [];
    for (let i = 0; i < 6; i++) {
      skew += 30_000;
      expect((await beat(owner, org)).json()).toEqual({ leaseSeconds: 90 });
    }
    // Publishing wrote seen_at, and the lease never lapsed: no beat needs to write.
    expect(dbWrites()).toBe(0);
    // A cached beat skips the transaction, the locks and the membership reads.
    expect(log.filter((q) => q.includes("pg_advisory_xact_lock"))).toEqual([]);
    expect(log.filter((q) => q.includes("from org_members"))).toEqual([]);
    const now = await seen(owner, org);
    expect(now[0].online).toBe(true);
    expect(Date.parse(now[0].expiresAt) - Date.parse(now[0].seenAt)).toBe(LEASE_MS);
    skew += LEASE_MS + 1_000;
    expect((await seen(owner, org))[0].online).toBe(false);
  });

  it("writes seen_at when the computer comes back online, and at least hourly while it beats", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    await publish(owner, org);
    log = [];
    skew += 5 * 60_000;
    expect((await beat(owner, org)).statusCode).toBe(200);
    expect(dbWrites()).toBe(1);
    // Beating every 30 s for an hour and a bit: two more writes at most.
    for (let t = 0; t < DB_WRITE_MS + 60_000; t += 30_000) {
      skew += 30_000;
      expect((await beat(owner, org)).statusCode).toBe(200);
    }
    // The first beat (back online), then one per hour: not one per revalidation every five minutes.
    expect(dbWrites()).toBe(2);
    // Past the identity window the full path ran again at least once, and everything still works.
    expect(IDENTITY_MS).toBeLessThan(DB_WRITE_MS);
    expect((await seen(owner, org))[0].online).toBe(true);
  }, 60_000);

  it("treats a stored seen_at from the last hour as online for 90 s after a restart, and no longer", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    await publish(owner, org);
    await app.close();
    // A new process: nothing in memory. The stored seen_at is fresh (published just now).
    app = startServer(base);
    expect((await seen(owner, org))[0].online).toBe(true);
    skew += BOOT_WINDOW_MS + 1_000;
    expect((await seen(owner, org))[0].online).toBe(false);
    // A restart long after the last write does not make a stale computer look online.
    await base.query("update org_fleet_computers set seen_at = now() - interval '2 hours'");
    await app.close();
    skew = 0;
    app = startServer(base);
    expect((await seen(owner, org))[0].online).toBe(false);
  });

  it("goes offline for a revoked token, a revoked device and a removed member", async () => {
    const owner = await account();
    const member = await account();
    const org = await orgWith(owner, member);
    await publish(member, org);
    await beat(member, org);
    expect((await seen(owner, org))[0]).toMatchObject({ deviceId: member.id, online: true });
    // The member leaves: the computer leaves the list and its next beat is refused, though its checks were remembered.
    const removed = await call(owner.token, "DELETE", `/v1/orgs/${org}/members/${member.user}`);
    expect(removed.statusCode).toBe(200);
    expect(await seen(owner, org)).toEqual([]);
    expect((await beat(member, org)).statusCode).toBe(404);

    // A second computer: revoke its sign-in.
    const other = await account();
    const org2 = await orgWith(owner, other);
    await publish(other, org2);
    await beat(other, org2);
    expect((await seen(owner, org2))[0].online).toBe(true);
    await base.query("update api_tokens set revoked_at = now() where user_id = $1", [other.user]);
    expect((await beat(other, org2)).statusCode).toBe(401);
    expect(await seen(owner, org2)).toEqual([]);
  });

  it("drops what a beat remembered when its device is revoked through the API", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    await publish(owner, org);
    expect((await beat(owner, org)).statusCode).toBe(200);
    // A second device of the account (with the keys) revokes the first.
    const t2 = await issueToken(base, owner.user);
    const d2 = (await call(t2, "POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Phone" })).json().deviceId;
    await call(owner.token, "PUT", `/v1/sync/keyrings/1/wraps/${d2}`, { wrap: vectors.wrap.blob });
    await call(t2, "POST", "/v1/sync/keyrings/1/proof", { proof: proof(1) });
    expect((await call(t2, "DELETE", `/v1/sync/devices/${owner.id}`)).statusCode).toBe(204);
    expect((await beat(owner, org)).statusCode).toBe(401);
  });

  it("keeps the same answers: 409 publish-required when nothing is published, 402 for a free plan", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    expect((await beat(owner, org)).json()).toEqual({ error: "publish-required" });
    await publish(owner, org);
    expect((await beat(owner, org)).statusCode).toBe(200);
    await base.query("update users set plan = 'free' where id = $1", [owner.user]);
    expect((await beat(owner, org)).statusCode).toBe(402);
  });
});

describe("personal fleet presence in memory", () => {
  it("renews a lease without writing, and expires it", async () => {
    const a = await account();
    expect((await call(a.token, "PUT", "/v1/fleet/self", { keyId: 1, revision: 1, descriptor: sealed() })).statusCode).toBe(201);
    log = [];
    for (let i = 0; i < 4; i++) {
      skew += 30_000;
      expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).json()).toEqual({ leaseSeconds: 90 });
    }
    expect(log.filter((q) => q.includes("update fleet_computers set seen_at"))).toEqual([]);
    expect(log.filter((q) => q.includes("pg_advisory_xact_lock"))).toEqual([]);
    const list = async () => (await call(a.token, "GET", "/v1/fleet")).json().computers;
    expect((await list())[0].online).toBe(true);
    skew += LEASE_MS + 1_000;
    expect((await list())[0].online).toBe(false);
    // Back online: one database write.
    log = [];
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(200);
    expect(log.filter((q) => q.includes("update fleet_computers set seen_at"))).toHaveLength(1);
    expect((await list())[0].online).toBe(true);
  });
});
