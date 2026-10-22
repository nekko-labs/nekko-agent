import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { SYNC_QUOTA } from "./sync.js";
import { pgliteDb } from "./test-db.js";

// The shared vectors from crates/nekko-sync: real sealed blobs, so the size
// checks here are the sizes the clients actually make.
const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));

let db: Db;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
});
afterEach(() => db.close());

const app = () => buildServer({ db, allowedOrigins: [], donationRateLimit: { max: 3, windowMs: 60_000 } });
type App = ReturnType<typeof app>;

async function user(plan: "free" | "pro" | "team" = "pro", email = `${randomBytes(4).toString("hex")}@example.com`) {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan) values ($1, $2) returning id", [email, plan]);
  return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
}

function call(a: App, token: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) {
  return a.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

const b64 = (n: number) => randomBytes(n).toString("base64url");
const devicePub = () => Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url");
const oid = () => b64(32);

async function setup(a: App, token: string) {
  const dev = await call(a, token, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "iPhone" });
  expect(dev.statusCode).toBe(201);
  const deviceId = dev.json().deviceId as string;
  const ring = await call(a, token, "PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId, wrap: vectors.wrap.blob }] });
  expect(ring.statusCode).toBe(201);
  return deviceId;
}

describe("sync auth and plans", () => {
  it("needs a valid, unrevoked token", async () => {
    const a = app();
    expect((await a.inject({ method: "GET", url: "/v1/sync/state" })).statusCode).toBe(401);
    expect((await call(a, `nk_${b64(32)}`, "GET", "/v1/sync/state")).statusCode).toBe(401);
    const u = await user();
    expect((await call(a, u.token, "GET", "/v1/sync/state")).statusCode).toBe(200);
    await db.query("update api_tokens set revoked_at = now()", []);
    expect((await call(a, u.token, "GET", "/v1/sync/state")).statusCode).toBe(401);
  });

  it("lets Pro and Team write, and Free only read and delete", async () => {
    const a = app();
    for (const plan of ["pro", "team"] as const) {
      const u = await user(plan);
      await setup(a, u.token);
    }
    const free = await user("free");
    const w = await call(a, free.token, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "Mac" });
    expect(w.statusCode).toBe(402);
    expect(w.json()).toEqual({ error: "plan-required", plan: "free", needs: ["pro", "team"] });
    const state = await call(a, free.token, "GET", "/v1/sync/state");
    expect(state.json()).toMatchObject({ plan: "free", canWrite: false, currentKeyId: null, usage: { bytes: 0, limit: 0 } });
    expect((await call(a, free.token, "GET", "/v1/sync/pull")).statusCode).toBe(200);
    expect((await call(a, free.token, "DELETE", "/v1/sync")).statusCode).toBe(204);
  });

  it("keeps a downgraded account's data readable but stops new writes", async () => {
    const a = app();
    const u = await user("pro");
    await setup(a, u.token);
    const id = oid();
    expect((await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: id, revision: 1, keyId: 1, blob: vectors.records[1].blob }] })).json().results[0].status).toBe("ok");
    await db.query("update users set plan = 'free' where id = $1", [u.id]);
    expect((await call(a, u.token, "GET", "/v1/sync/pull")).json().objects).toHaveLength(1);
    expect((await call(a, u.token, "GET", "/v1/sync/keyrings/1")).statusCode).toBe(200);
    expect((await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: id, revision: 2, keyId: 1, blob: vectors.records[2].blob }] })).statusCode).toBe(402);
  });
});

describe("devices and keyrings", () => {
  it("binds the token to its device and hands each device only its own wrap", async () => {
    const a = app();
    const u = await user();
    const deviceId = await setup(a, u.token);
    const state = (await call(a, u.token, "GET", "/v1/sync/state")).json();
    expect(state).toMatchObject({ device: deviceId, currentKeyId: 1, devices: [{ id: deviceId, label: "iPhone", revokedAt: null }] });
    expect((await call(a, u.token, "GET", "/v1/sync/keyrings/1")).json()).toEqual({ keyId: 1, recoveryWrap: vectors.recovery.blob, wrap: vectors.wrap.blob });
    // A second token (a new device signing in) sees the recovery wrap but no device wrap until enrolled.
    const t2 = await issueToken(db, u.id);
    expect((await call(a, t2, "GET", "/v1/sync/keyrings/1")).json().wrap).toBeNull();
    expect((await call(a, u.token, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "again" })).statusCode).toBe(409);
    const d2 = (await call(a, t2, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "MacBook" })).json().deviceId;
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${d2}`, { wrap: vectors.wrap.blob })).statusCode).toBe(204);
    expect((await call(a, t2, "GET", "/v1/sync/keyrings/1")).json().wrap).toBe(vectors.wrap.blob);
  });

  it("refuses malformed keys and wraps of the wrong size", async () => {
    const a = app();
    const u = await user();
    const compressed = Buffer.concat([Buffer.from([3]), randomBytes(64)]).toString("base64url");
    for (const body of [
      { publicKey: compressed, label: "x" },
      { publicKey: b64(64), label: "x" },
      { publicKey: `${devicePub()}=`, label: "x" },
      { publicKey: devicePub(), label: "" },
      { publicKey: devicePub(), label: "x".repeat(41) },
    ]) {
      expect((await call(a, u.token, "POST", "/v1/sync/devices", body)).statusCode).toBe(400);
    }
    const t = await issueToken(db, u.id);
    const d = (await call(a, t, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "ok" })).json().deviceId;
    expect((await call(a, t, "PUT", "/v1/sync/keyrings/1", { recoveryWrap: b64(145), wraps: [] })).statusCode).toBe(400);
    expect((await call(a, t, "PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: d, wrap: b64(145) }] })).statusCode).toBe(400);
  });

  it("adds key epochs one at a time and only for the account's live devices", async () => {
    const a = app();
    const u = await user();
    const other = await user();
    const theirs = await setup(a, other.token);
    const mine = await setup(a, u.token);
    expect((await call(a, u.token, "PUT", "/v1/sync/keyrings/3", { recoveryWrap: vectors.recovery.blob, wraps: [] })).json()).toEqual({ error: "key-epoch", currentKeyId: 1 });
    expect((await call(a, u.token, "PUT", "/v1/sync/keyrings/2", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: theirs, wrap: vectors.wrap.blob }] })).json()).toEqual({ error: "unknown-device" });
    expect((await call(a, u.token, "GET", "/v1/sync/state")).json().currentKeyId).toBe(1);
    expect((await call(a, u.token, "PUT", "/v1/sync/keyrings/2", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: mine, wrap: vectors.wrap.blob }] })).statusCode).toBe(201);
  });

  it("revoking a device kills its tokens and wraps, and its key can't come back", async () => {
    const a = app();
    const u = await user();
    const phoneToken = await issueToken(db, u.id);
    await setup(a, u.token);
    const key = devicePub();
    const phone = (await call(a, phoneToken, "POST", "/v1/sync/devices", { publicKey: key, label: "Lost phone" })).json().deviceId;
    await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${phone}`, { wrap: vectors.wrap.blob });
    expect((await call(a, u.token, "DELETE", `/v1/sync/devices/${phone}`)).statusCode).toBe(204);
    expect((await call(a, phoneToken, "GET", "/v1/sync/state")).statusCode).toBe(401);
    const { rows } = await db.query("select count(*)::int as n from sync_key_wraps where device_id = $1", [phone]);
    expect(rows).toEqual([{ n: 0 }]);
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${phone}`, { wrap: vectors.wrap.blob })).statusCode).toBe(400);
    const t3 = await issueToken(db, u.id);
    expect((await call(a, t3, "POST", "/v1/sync/devices", { publicKey: key, label: "Found it" })).json()).toEqual({ error: "device-revoked" });
    // Another account can't revoke it.
    const other = await user();
    expect((await call(a, other.token, "DELETE", `/v1/sync/devices/${phone}`)).statusCode).toBe(404);
  });
});

describe("only a device holding the keys changes them", () => {
  // Someone who can sign in to the account (an emailed code is enough) but has
  // no synced device must not be able to start an epoch, add wraps, push,
  // remove devices or wipe the account. The clients check wraps themselves;
  // this is the server's half.
  it("refuses key, device and data changes from a token without the current keys", async () => {
    const a = app();
    const u = await user();
    const mine = await setup(a, u.token);
    const intruder = await issueToken(db, u.id);
    const theirs = (await call(a, intruder, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "Intruder" })).json().deviceId;
    const refused = { error: "needs-synced-device" };
    expect((await call(a, intruder, "PUT", "/v1/sync/keyrings/2", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: mine, wrap: vectors.wrap.blob }, { deviceId: theirs, wrap: vectors.wrap.blob }] })).json()).toEqual(refused);
    expect((await call(a, intruder, "PUT", `/v1/sync/keyrings/1/wraps/${mine}`, { wrap: vectors.wrap.blob })).json()).toEqual(refused);
    expect((await call(a, intruder, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: oid(), revision: 1, keyId: 1, blob: vectors.records[1].blob }] })).json()).toEqual(refused);
    expect((await call(a, intruder, "DELETE", `/v1/sync/devices/${mine}`)).json()).toEqual(refused);
    // A token without any device can't either.
    const bare = await issueToken(db, u.id);
    expect((await call(a, bare, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: oid(), revision: 1, keyId: 1, blob: vectors.records[1].blob }] })).statusCode).toBe(403);
    // A device can always remove itself, and wrap the current epoch to itself (after a restore).
    expect((await call(a, intruder, "PUT", `/v1/sync/keyrings/1/wraps/${theirs}`, { wrap: vectors.wrap.blob })).statusCode).toBe(204);
    expect((await call(a, intruder, "DELETE", `/v1/sync/devices/${theirs}`)).statusCode).toBe(204);
  });

  it("never overwrites a wrap, and adds wraps only to the current epoch", async () => {
    const a = app();
    const u = await user();
    const mine = await setup(a, u.token);
    const t2 = await issueToken(db, u.id);
    const d2 = (await call(a, t2, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "MacBook" })).json().deviceId;
    const other = vectors.join.blob;
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${mine}`, { wrap: other })).json()).toEqual({ error: "wrap-exists" });
    expect((await call(a, u.token, "GET", "/v1/sync/keyrings/1")).json().wrap).toBe(vectors.wrap.blob);
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${d2}`, { wrap: other })).statusCode).toBe(204);
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${d2}`, { wrap: vectors.wrap.blob })).statusCode).toBe(409);
    expect((await call(a, u.token, "PUT", "/v1/sync/keyrings/2", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: mine, wrap: vectors.wrap.blob }] })).statusCode).toBe(201);
    const t3 = await issueToken(db, u.id);
    const d3 = (await call(a, t3, "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "iPad" })).json().deviceId;
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/1/wraps/${d3}`, { wrap: other })).json()).toEqual({ error: "key-epoch", currentKeyId: 2 });
    expect((await call(a, u.token, "PUT", `/v1/sync/keyrings/3/wraps/${d3}`, { wrap: other })).statusCode).toBe(404);
  });

  it("binds a new sign-in's token to the same key, and keeps a join tag", async () => {
    const a = app();
    const u = await user();
    const key = devicePub();
    const tag = b64(32);
    const first = await call(a, u.token, "POST", "/v1/sync/devices", { publicKey: key, label: "MacBook", joinTag: tag });
    expect(first.statusCode).toBe(201);
    const id = first.json().deviceId;
    // Signed out and in again: the new token registers the same key and is bound to the device.
    const again = await issueToken(db, u.id);
    expect((await call(a, again, "POST", "/v1/sync/devices", { publicKey: key, label: "MacBook" })).json()).toEqual({ deviceId: id });
    expect((await call(a, again, "GET", "/v1/sync/state")).json()).toMatchObject({ device: id, devices: [{ id, joinTag: tag }] });
    // So revoking the device ends that token too.
    expect((await call(a, again, "DELETE", `/v1/sync/devices/${id}`)).statusCode).toBe(204);
    expect((await call(a, again, "GET", "/v1/sync/state")).statusCode).toBe(401);
    expect((await call(a, u.token, "GET", "/v1/sync/state")).statusCode).toBe(401);
    expect((await call(a, await issueToken(db, u.id), "POST", "/v1/sync/devices", { publicKey: devicePub(), label: "x", joinTag: b64(31) })).statusCode).toBe(400);
  });

  it("wipes everything only from a keyed device or right after a fresh sign-in", async () => {
    const a = app();
    const u = await user();
    await setup(a, u.token);
    const stale = await issueToken(db, u.id);
    await db.query("update api_tokens set created_at = now() - interval '1 hour'", []);
    expect((await call(a, stale, "DELETE", "/v1/sync")).json()).toEqual({ error: "needs-fresh-sign-in" });
    const fresh = await issueToken(db, u.id);
    expect((await call(a, fresh, "DELETE", "/v1/sync")).statusCode).toBe(204);
  });

  it("reads one object out of feed order", async () => {
    const a = app();
    const u = await user();
    await setup(a, u.token);
    const id = oid();
    await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "account", objectId: id, revision: 1, keyId: 1, blob: vectors.records[1].blob }] });
    expect((await call(a, u.token, "GET", `/v1/sync/objects/account/${id}`)).json()).toMatchObject({ collection: "account", objectId: id, revision: 1, keyId: 1 });
    expect((await call(a, u.token, "GET", `/v1/sync/objects/account/${oid()}`)).statusCode).toBe(404);
    const other = await user();
    expect((await call(a, other.token, "GET", `/v1/sync/objects/account/${id}`)).statusCode).toBe(404);
  });
});

describe("push and pull", () => {
  it("stores ciphertext only and orders changes", async () => {
    const a = app();
    const u = await user();
    await setup(a, u.token);
    const [x, y] = [oid(), oid()];
    const push = await call(a, u.token, "POST", "/v1/sync/push", {
      objects: [
        { collection: "chat", objectId: x, revision: 1, keyId: 1, blob: vectors.records[0].blob },
        { collection: "chat-part", objectId: y, revision: 1, keyId: 1, blob: vectors.longRecord.blob },
      ],
    });
    expect(push.json().results.map((r: { status: string }) => r.status)).toEqual(["ok", "ok"]);
    await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: x, revision: 2, keyId: 1, blob: vectors.records[1].blob }] });
    const all = (await call(a, u.token, "GET", "/v1/sync/pull")).json();
    expect(all.objects.map((o: { objectId: string; revision: number }) => [o.objectId, o.revision])).toEqual([[y, 1], [x, 2]]);
    expect(all.objects[1].blob).toBe(vectors.records[1].blob);
    const page = (await call(a, u.token, "GET", "/v1/sync/pull?limit=1")).json();
    expect(page).toMatchObject({ more: true, objects: [{ objectId: y }] });
    const rest = (await call(a, u.token, "GET", `/v1/sync/pull?since=${page.next}`)).json();
    expect(rest).toMatchObject({ more: false, objects: [{ objectId: x }] });
    // Nothing readable reaches the database.
    const { rows } = await db.query<{ blob: Buffer }>("select blob from sync_objects", []);
    for (const r of rows) expect(Buffer.from(r.blob).toString("latin1")).not.toMatch(/Kyoto|title|猫/);
    const usage = (await call(a, u.token, "GET", "/v1/sync/state")).json().usage.bytes;
    expect(usage).toBe(rows.reduce((n, r) => n + Buffer.from(r.blob).length, 0));
  });

  it("answers conflicts and stale key epochs per object", async () => {
    const a = app();
    const u = await user();
    const d = await setup(a, u.token);
    const x = oid();
    const blob = vectors.records[1].blob;
    await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: x, revision: 1, keyId: 1, blob }] });
    const res = await call(a, u.token, "POST", "/v1/sync/push", {
      objects: [
        { collection: "chat", objectId: x, revision: 1, keyId: 1, blob },
        { collection: "chat", objectId: x, revision: 3, keyId: 1, blob },
        { collection: "chat", objectId: oid(), revision: 2, keyId: 1, blob },
      ],
    });
    expect(res.json().results.map((r: { status: string; revision: number }) => [r.status, r.revision])).toEqual([["conflict", 1], ["conflict", 1], ["conflict", 0]]);
    await call(a, u.token, "PUT", "/v1/sync/keyrings/2", { recoveryWrap: vectors.recovery.blob, wraps: [{ deviceId: d, wrap: vectors.wrap.blob }] });
    const stale = await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: x, revision: 2, keyId: 1, blob }] });
    expect(stale.json().results[0]).toEqual({ objectId: x, status: "stale-key", currentKeyId: 2 });
    const fresh = await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: x, revision: 2, keyId: 2, blob }] });
    expect(fresh.json().results[0].status).toBe("ok");
  });

  it("refuses bad objects and keeps accounts apart", async () => {
    const a = app();
    const u = await user();
    const other = await user();
    await setup(a, u.token);
    await setup(a, other.token);
    const ok = { collection: "chat", objectId: oid(), revision: 1, keyId: 1, blob: vectors.records[1].blob };
    for (const bad of [
      { ...ok, collection: "Chat" },
      { ...ok, objectId: "short" },
      { ...ok, revision: 0 },
      { ...ok, revision: 1.5 },
      { ...ok, blob: b64(100) },
      { ...ok, blob: `${ok.blob}=` },
    ]) {
      expect((await call(a, u.token, "POST", "/v1/sync/push", { objects: [bad] })).statusCode).toBe(400);
    }
    expect((await call(a, u.token, "POST", "/v1/sync/push", { objects: [] })).statusCode).toBe(400);
    await call(a, u.token, "POST", "/v1/sync/push", { objects: [ok] });
    expect((await call(a, other.token, "GET", "/v1/sync/pull")).json().objects).toEqual([]);
  });

  it("rolls back a push that would go over the plan's storage", async () => {
    const a = app();
    const u = await user();
    await setup(a, u.token);
    await db.query("insert into sync_usage (user_id, bytes) values ($1, $2)", [u.id, SYNC_QUOTA.pro - 100]);
    const res = await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: oid(), revision: 1, keyId: 1, blob: vectors.records[1].blob }] });
    expect(res.statusCode).toBe(413);
    expect((await call(a, u.token, "GET", "/v1/sync/pull")).json().objects).toEqual([]);
    expect((await call(a, u.token, "GET", "/v1/sync/state")).json().usage.bytes).toBe(SYNC_QUOTA.pro - 100);
  });

  it("deletes everything synced on request, and the account stays", async () => {
    const a = app();
    const u = await user();
    await setup(a, u.token);
    await call(a, u.token, "POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: oid(), revision: 1, keyId: 1, blob: vectors.records[1].blob }] });
    expect((await call(a, u.token, "DELETE", "/v1/sync")).statusCode).toBe(204);
    for (const t of ["sync_objects", "sync_keyrings", "sync_key_wraps", "sync_devices", "sync_usage"]) {
      const { rows } = await db.query(`select count(*)::int as n from ${t}`, []);
      expect(rows, t).toEqual([{ n: 0 }]);
    }
    expect((await call(a, u.token, "GET", "/v1/sync/state")).json()).toMatchObject({ currentKeyId: null, devices: [], device: null });
    await setup(a, u.token);
  });
});

describe("sync rate limit", () => {
  it("answers 429 past the limit, before the token is even checked", async () => {
    const a = buildServer({ db, allowedOrigins: [], syncRateLimit: { max: 2, windowMs: 60_000 } });
    const u = await user();
    expect((await call(a, u.token, "GET", "/v1/sync/state")).statusCode).toBe(200);
    expect((await call(a, `nk_${b64(32)}`, "GET", "/v1/sync/state")).statusCode).toBe(401);
    expect((await call(a, u.token, "GET", "/v1/sync/state")).statusCode).toBe(429);
    // Signups keep their own limiter.
    expect((await a.inject({ method: "POST", url: "/v1/signups", payload: { email: "a@b.co" } })).statusCode).toBe(202);
  });
});

describe("donations", () => {
  const donation = () => ({ id: vectors.donation.id, blob: vectors.donation.blob, deleteHash: vectors.donation.deleteHash });

  it("stores a sealed donation with nothing about the sender", async () => {
    const a = app();
    const res = await a.inject({ method: "POST", url: "/v1/donations", payload: donation(), headers: { authorization: "Bearer ignored" } });
    expect(res.statusCode).toBe(202);
    const { rows } = await db.query<Record<string, unknown>>("select * from donations", []);
    expect(Object.keys(rows[0]).sort()).toEqual(["blob", "created_on", "delete_hash", "expires_on", "id"]);
    expect(Buffer.from(rows[0].blob as Buffer).toString("latin1")).not.toMatch(/Kyoto|redacted/);
  });

  it("withdraws only with the delete token", async () => {
    const a = app();
    await a.inject({ method: "POST", url: "/v1/donations", payload: donation() });
    const del = (token: string) => a.inject({ method: "DELETE", url: `/v1/donations/${vectors.donation.id}`, headers: { "x-delete-token": token } });
    expect((await del(b64(32))).statusCode).toBe(404);
    expect((await del(vectors.donation.deleteToken)).statusCode).toBe(204);
    expect((await db.query("select count(*)::int as n from donations", [])).rows).toEqual([{ n: 0 }]);
  });

  it("refuses malformed donations and rate-limits", async () => {
    const a = app();
    expect((await a.inject({ method: "POST", url: "/v1/donations", payload: { ...donation(), id: "x" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/v1/donations", payload: { ...donation(), blob: b64(10) } })).statusCode).toBe(400);
    await a.inject({ method: "POST", url: "/v1/donations", payload: donation() });
    expect((await a.inject({ method: "POST", url: "/v1/donations", payload: donation() })).statusCode).toBe(429);
  });
});
