import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken, TOKEN_IDLE_DAYS } from "./auth.js";
import type { Db } from "./db.js";
import { FEATURES_CACHE_MS } from "./features.js";
import { MemoryGate, PAGE_FACTOR } from "./memory-gate.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));
const b64 = (n: number) => randomBytes(n).toString("base64url");

let base: Db;
let log: string[];
/** The database with every statement recorded. */
const recording = (): Db => {
  const rec = (db: Db): Db => ({
    query: (t, p) => { log.push(t); return db.query(t, p); },
    transaction: (fn) => db.transaction((tx) => fn(rec(tx))),
    close: () => db.close(),
  });
  return rec(base);
};
beforeEach(async () => {
  base = pgliteDb(new PGlite());
  await migrate(base, undefined, { lock: false });
  log = [];
});
afterEach(() => base.close());

async function account(email = `${b64(4)}@example.com`, plan = "pro") {
  const { rows } = await base.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, $2, true) returning id", [email, plan]);
  return { id: rows[0].id, token: await issueToken(base, rows[0].id) };
}

describe("authenticate on the hot path", () => {
  it("reads, and writes last_used_at and the expiry only when it is older than this hour", async () => {
    const app = buildServer({ db: recording(), allowedOrigins: [] });
    const u = await account();
    const me = () => app.inject({ method: "GET", url: "/v1/sync/state", headers: { authorization: `Bearer ${u.token}` } });
    const tokenRow = async () => (await base.query<{ last_used_at: Date | null; expires_at: Date; fresh: boolean }>(
      "select last_used_at, expires_at, last_used_at >= date_trunc('hour', now()) as fresh from api_tokens where user_id = $1", [u.id])).rows[0];
    const updates = () => log.filter((q) => q.includes("update api_tokens")).length;

    expect((await tokenRow()).last_used_at).toBeNull();
    expect((await me()).statusCode).toBe(200);
    expect((await tokenRow()).fresh).toBe(true);
    expect(updates()).toBe(1);
    // Marker expiry: a request in the same hour must not touch it.
    await base.query("update api_tokens set expires_at = now() + interval '5 days' where user_id = $1", [u.id]);
    for (let i = 0; i < 5; i++) expect((await me()).statusCode).toBe(200);
    expect(updates()).toBe(1);
    expect((await base.query<{ d: number }>("select extract(day from expires_at - now())::int as d from api_tokens where user_id = $1", [u.id])).rows[0].d).toBeLessThan(6);
    // An hour later the next request renews both.
    await base.query("update api_tokens set last_used_at = now() - interval '2 hours' where user_id = $1", [u.id]);
    expect((await me()).statusCode).toBe(200);
    expect(updates()).toBe(2);
    const days = (await base.query<{ d: number }>("select extract(day from expires_at - now())::int as d from api_tokens where user_id = $1", [u.id])).rows[0].d;
    expect(days).toBeGreaterThanOrEqual(TOKEN_IDLE_DAYS - 1);
    await app.close();
  });

  it("still refuses an expired or revoked token", async () => {
    const app = buildServer({ db: recording(), allowedOrigins: [] });
    const u = await account();
    const me = () => app.inject({ method: "GET", url: "/v1/sync/state", headers: { authorization: `Bearer ${u.token}` } });
    await base.query("update api_tokens set expires_at = now() - interval '1 second' where user_id = $1", [u.id]);
    expect((await me()).statusCode).toBe(401);
    await base.query("update api_tokens set expires_at = now() + interval '1 day', revoked_at = now() where user_id = $1", [u.id]);
    expect((await me()).statusCode).toBe(401);
    await app.close();
  });
});

describe("the feature switches are remembered briefly", () => {
  it("reads them once for many calls, and a staff change shows at once", async () => {
    const app = buildServer({ db: recording(), allowedOrigins: [] });
    const staff = await account("philip@nekkolabs.com");
    const other = await account();
    const features = (token: string) => app.inject({ method: "GET", url: "/v1/features", headers: { authorization: `Bearer ${token}` } });
    const reads = () => log.filter((q) => q.includes("from feature_flags")).length;
    expect((await features(other.token)).json().features["library-cloud"]).toBe(false);
    for (let i = 0; i < 4; i++) await features(other.token);
    expect(reads()).toBe(1);
    expect(log.filter((q) => q.includes("email_verified from users")).length).toBe(1);
    const put = await app.inject({ method: "PUT", url: "/v1/staff/features/library-cloud", headers: { authorization: `Bearer ${staff.token}` }, payload: { state: "on" } });
    expect(put.statusCode).toBe(200);
    expect((await features(other.token)).json().features["library-cloud"]).toBe(true);
    expect(FEATURES_CACHE_MS).toBeGreaterThan(0);
    await app.close();
  });
});

describe("push and shares on the pooled database", () => {
  async function syncedUser(db: Db = base, gate?: MemoryGate) {
    const app = buildServer({ db, allowedOrigins: [], memoryGate: gate ?? false });
    const u = await account();
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${u.token}` }, payload });
    const dev = await call("POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Mac" });
    const proof = vectors.epochProofs.find((p: { keyId: number }) => p.keyId === 1)?.proof ?? b64(32);
    await call("PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, proof, wraps: [{ deviceId: dev.json().deviceId, wrap: vectors.wrap.blob }] });
    return { app, call, u };
  }
  const obj = (id: string, revision: number, size = 400, collection = "chat") => ({ collection, objectId: id, revision, keyId: 1, blob: b64(size) });
  const ids = (n: number) => Array.from({ length: n }, () => b64(32));

  it("pushes many objects in a few statements, with the same answers in the same order", async () => {
    const { app, call, u } = await syncedUser(recording());
    const [a, b, c, d] = ids(4);
    await call("POST", "/v1/sync/push", { objects: [obj(a, 1), obj(b, 1)] });
    log = [];
    const many = ids(60);
    const res = await call("POST", "/v1/sync/push", {
      objects: [obj(a, 2), obj(b, 5), ...many.map((m) => obj(m, 1)), { ...obj(c, 1), keyId: 7 }, obj(d, 1, 300 * 1024)],
    });
    expect(res.statusCode).toBe(200);
    const r = res.json().results;
    expect(r[0]).toEqual({ objectId: a, status: "ok", revision: 2 });
    expect(r[1]).toEqual({ objectId: b, status: "conflict", revision: 1 });
    expect(r[2]).toEqual({ objectId: many[0], status: "ok", revision: 1 });
    expect(r[62]).toEqual({ objectId: c, status: "stale-key", currentKeyId: 1 });
    expect(r[63]).toEqual({ objectId: d, status: "ok", revision: 1 });
    // The lock, the epoch checks, one read of what is stored, a batched write, the big one alone, usage: not 60 * 2.
    expect(log.length).toBeLessThan(15);
    // Sequence numbers follow the request's order.
    const { rows } = await base.query<{ object_id: string }>("select object_id from sync_objects where user_id = $1 and object_id = any($2) order by seq", [u.id, many]);
    expect(rows.map((x) => x.object_id)).toEqual(many);
    // Stored bytes: every byte of what is there counts once.
    const total = (await base.query<{ n: string }>("select sum(octet_length(blob)) as n from sync_objects where user_id = $1", [u.id])).rows[0].n;
    expect((await base.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [u.id])).rows[0].bytes).toBe(total);
    await app.close();
  });

  it("applies the same object named twice in order, and keeps Library revisions as history", async () => {
    const { app, call, u } = await syncedUser();
    const [a, lib] = ids(2);
    const twice = await call("POST", "/v1/sync/push", { objects: [obj(a, 1), obj(a, 2), obj(a, 2)] });
    expect(twice.json().results.map((x: { status: string }) => x.status)).toEqual(["ok", "ok", "conflict"]);
    await call("POST", "/v1/sync/push", { objects: [obj(lib, 1, 500, "library")] });
    await call("POST", "/v1/sync/push", { objects: [obj(lib, 2, 600, "library")] });
    const hist = await base.query("select revision from sync_object_history where user_id = $1 and object_id = $2", [u.id, lib]);
    expect(hist.rows).toHaveLength(1);
    const total = (await base.query<{ n: string }>("select sum(octet_length(blob)) as n from sync_objects where user_id = $1", [u.id])).rows[0].n;
    const kept = (await base.query<{ n: string }>("select sum(octet_length(blob)) as n from sync_object_history where user_id = $1", [u.id])).rows[0].n;
    expect(Number((await base.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [u.id])).rows[0].bytes)).toBe(Number(total) + Number(kept));
    await app.close();
  });

  it("answers only after the transaction has committed", async () => {
    // A database whose commit fails: the client must not have been told 201.
    const failing: Db = { ...base, transaction: async (fn) => { await base.transaction(fn); throw new Error("commit failed"); } };
    const { app, call } = await syncedUser(base);
    const bad = buildServer({ db: failing, allowedOrigins: [] });
    const u = await account();
    const res = await bad.inject({ method: "POST", url: "/v1/sync/devices", headers: { authorization: `Bearer ${u.token}` }, payload: { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Mac" } });
    expect(res.statusCode).toBe(500);
    expect(call).toBeDefined();
    await bad.close();
    await app.close();
  });

  async function sharer() {
    const rec = recording();
    const app = buildServer({ db: rec, allowedOrigins: [], memoryGate: new MemoryGate({ budgetBytes: 64 * 1024 * 1024 }) });
    const u = await account("philip@nekkolabs.com");
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${u.token}` }, payload });
    await call("PUT", "/v1/staff/features/library-cloud", { state: "on" });
    return { app, call };
  }

  it("never reads a share's blob for control calls, and restores a version inside the database", async () => {
    const { app, call } = await sharer();
    const first = b64(300);
    const created = (await call("POST", "/v1/shares", { blob: first })).json();
    expect((await call("PUT", `/v1/shares/${created.id}`, { blob: b64(310), revision: 1 })).json()).toEqual({ id: created.id, revision: 2 });
    log = [];
    const versions = await call("GET", `/v1/shares/${created.id}/versions`);
    expect(versions.json().current.size).toBe(Buffer.from(b64(310), "base64url").length);
    await call("DELETE", `/v1/shares/${created.id}`);
    await call("POST", `/v1/shares/${created.id}/restore`);
    const blobReads = log.filter((q) => /select\s+(\*|.*\bblob\b(?!\)))/.test(q.replace(/octet_length\(blob\)/g, "")) && q.includes("library_shares"));
    expect(blobReads).toEqual([]);
    const back = await call("POST", `/v1/shares/${created.id}/versions/1/restore`);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({ id: created.id, revision: 3 });
    // No statement carried the blob through this process.
    expect(log.filter((q) => q.includes("update library_shares set blob = (select blob"))).toHaveLength(1);
    const open = await app.inject({ method: "GET", url: `/v1/s/${created.id}` });
    expect(open.json()).toEqual({ id: created.id, revision: 3, blob: first });
    expect((await call("POST", `/v1/shares/${created.id}/versions/9/restore`)).statusCode).toBe(404);
    await app.close();
  });

  it("makes the public share link wait for memory like a sync page, and 503s when there is none", async () => {
    const gate = new MemoryGate({ budgetBytes: 1500 * PAGE_FACTOR, maxWaitMs: 30 });
    const app = buildServer({ db: base, allowedOrigins: [], memoryGate: gate });
    const u = await account("philip@nekkolabs.com");
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${u.token}` }, payload });
    await call("PUT", "/v1/staff/features/library-cloud", { state: "on" });
    const created = (await call("POST", "/v1/shares", { blob: b64(2000) })).json();
    // The share's 1500 bytes weigh 10,500: with 2,000 already held they do not fit.
    const hold = await gate.acquire(2000);
    const busy = await app.inject({ method: "GET", url: `/v1/s/${created.id}` });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers["retry-after"]).toBe("5");
    hold();
    expect((await app.inject({ method: "GET", url: `/v1/s/${created.id}` })).statusCode).toBe(200);
    expect(gate.stats).toEqual({ inFlightBytes: 0, running: 0, queued: 0 });
    await app.close();
  });
});
