import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { MAX_DESCRIPTOR_BYTES, MAX_FLEET_COMPUTERS } from "./fleet.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));
const b64 = (n: number) => randomBytes(n).toString("base64url");
const proof = (k: number): string => vectors.epochProofs.find((p: { keyId: number }) => p.keyId === k)?.proof ?? b64(32);
const sealed = () => Buffer.concat([Buffer.from([1]), randomBytes(304)]).toString("base64url");
let db: Db;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  app = buildServer({ db, allowedOrigins: [], fleetEnabled: true });
});
afterEach(async () => { await app.close(); await db.close(); });

function call(token: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}
async function account() {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan) values ($1, 'pro') returning id", [`${b64(8)}@example.com`]);
  const token = await issueToken(db, rows[0].id);
  const id = await device(token);
  expect((await call(token, "PUT", "/v1/sync/keyrings/1", {
    recoveryWrap: vectors.recovery.blob, proof: proof(1), wraps: [{ deviceId: id, wrap: vectors.wrap.blob }],
  })).statusCode).toBe(201);
  return { user: rows[0].id, token, id };
}
async function device(token: string) {
  const r = await call(token, "POST", "/v1/sync/devices", {
    publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Test device",
  });
  expect(r.statusCode).toBe(201);
  return r.json().deviceId as string;
}
async function join(a: Awaited<ReturnType<typeof account>>, prove = true) {
  const token = await issueToken(db, a.user);
  const id = await device(token);
  expect((await call(a.token, "PUT", `/v1/sync/keyrings/1/wraps/${id}`, { wrap: vectors.wrap.blob })).statusCode).toBe(204);
  if (prove) expect((await call(token, "POST", "/v1/sync/keyrings/1/proof", { proof: proof(1) })).statusCode).toBe(204);
  return { token, id };
}
const publish = (token: string, revision = 1, keyId = 1, descriptor = sealed()) =>
  call(token, "PUT", "/v1/fleet/self", { keyId, revision, descriptor });
const list = async (token: string) => (await call(token, "GET", "/v1/fleet")).json().computers;

describe("account fleet discovery (not pairing or execution)", () => {
  it("is absent unless explicitly enabled", async () => {
    const off = buildServer({ db, allowedOrigins: [] });
    try {
      for (const [method, url] of [["GET", "/v1/fleet"], ["PUT", "/v1/fleet/self"], ["POST", "/v1/fleet/self/heartbeat"], ["DELETE", "/v1/fleet/self"]] as const) {
        expect((await off.inject({ method, url })).statusCode).toBe(404);
      }
    } finally { await off.close(); }
  });

  it("requires a live token, unlocked device and current epoch proof, not just sign-in or a wrap", async () => {
    const a = await account();
    const bare = await issueToken(db, a.user);
    const waiting = await join(a, false);
    for (const token of ["", bare, waiting.token]) {
      const status = token ? 403 : 401;
      expect((await call(token, "GET", "/v1/fleet")).statusCode).toBe(status);
      expect((await publish(token)).statusCode).toBe(status);
      expect((await call(token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(status);
    }
    expect((await call(waiting.token, "POST", "/v1/sync/keyrings/1/proof", { proof: proof(1) })).statusCode).toBe(204);
    expect((await publish(waiting.token)).statusCode).toBe(201);
    const response = await call(a.token, "GET", "/v1/fleet");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().computers).toHaveLength(1);
  });

  it("returns only the unlocked account's opaque descriptors with server-owned identity and lease", async () => {
    const a = await account();
    const phone = await join(a);
    const other = await account();
    const descriptor = sealed();
    expect((await publish(a.token, 1, 1, descriptor)).statusCode).toBe(201);
    expect((await publish(other.token)).statusCode).toBe(201);
    const rows = await list(phone.token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: a.id, keyId: 1, revision: 1, descriptor, online: true });
    expect(Date.parse(rows[0].expiresAt) - Date.parse(rows[0].seenAt)).toBe(90_000);
    expect((await list(other.token))[0].deviceId).toBe(other.id);
    expect((await call(phone.token, "PUT", "/v1/fleet/self", { keyId: 1, revision: 1, descriptor, deviceId: a.id })).statusCode).toBe(400);
    expect((await call(phone.token, "DELETE", `/v1/fleet/${a.id}`)).statusCode).toBe(404);
  });

  it("expires presence, restores it by heartbeat, and cannot heartbeat an unpublished computer", async () => {
    const a = await account();
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).json()).toEqual({ error: "publish-required" });
    await publish(a.token);
    await db.query("update fleet_computers set seen_at = now() - interval '91 seconds'");
    expect((await list(a.token))[0].online).toBe(false);
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(200);
    expect((await list(a.token))[0]).toMatchObject({ online: true, revision: 1 });
  });

  it("rejects malformed, oversized and unknown-version descriptors and stale revisions", async () => {
    const a = await account();
    for (const descriptor of [b64(304), b64(MAX_DESCRIPTOR_BYTES + 1), `${sealed()}=`, Buffer.alloc(305).toString("base64url")]) {
      expect((await publish(a.token, 1, 1, descriptor)).statusCode).toBe(400);
    }
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await publish(a.token, revision)).statusCode).toBe(400);
    }
    expect((await publish(a.token, 1, 2)).json()).toEqual({ error: "key-epoch", currentKeyId: 1 });
    expect((await publish(a.token)).statusCode).toBe(201);
    expect((await publish(a.token)).json()).toEqual({ error: "revision", currentRevision: 1 });
    expect((await publish(a.token, 3)).statusCode).toBe(409);
    expect((await publish(a.token, 2)).statusCode).toBe(200);
  });

  it("withdraws only oneself, invalidates queued publishes and retains the revision guard", async () => {
    const a = await account();
    const phone = await join(a);
    await publish(a.token);
    await call(phone.token, "DELETE", "/v1/fleet/self");
    expect(await list(a.token)).toHaveLength(1);
    expect((await call(a.token, "DELETE", "/v1/fleet/self")).statusCode).toBe(204);
    expect(await list(phone.token)).toEqual([]);
    expect((await publish(a.token, 2)).json()).toEqual({ error: "revision", currentRevision: 2 });
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(409);
    expect((await publish(a.token, 3)).statusCode).toBe(200);
  });

  it("hides a signed-out host immediately and requires a freshly unlocked sign-in to republish", async () => {
    const a = await account();
    const phone = await join(a);
    await publish(a.token);
    expect((await call(a.token, "DELETE", "/v1/auth/session")).statusCode).toBe(204);
    expect(await list(phone.token)).toEqual([]);
    expect((await publish(a.token, 2)).statusCode).toBe(401);
    const again = await issueToken(db, a.user);
    const { createHash } = await import("node:crypto");
    await db.query("update api_tokens set device_id = $1 where token_hash = $2", [a.id, createHash("sha256").update(again).digest()]);
    expect((await publish(again, 2)).statusCode).toBe(403);
    await call(again, "POST", "/v1/sync/keyrings/1/proof", { proof: proof(1) });
    expect((await call(again, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(409);
    expect((await publish(again, 2)).statusCode).toBe(200);
    expect(await list(phone.token)).toHaveLength(1);
  });

  it("hides revoked hosts and refuses revoked phones, including already-advertised ones", async () => {
    const a = await account();
    const phone = await join(a);
    await publish(phone.token);
    expect((await call(a.token, "DELETE", `/v1/sync/devices/${phone.id}`)).statusCode).toBe(204);
    expect(await list(a.token)).toEqual([]);
    expect((await db.query("select count(*)::int as n from fleet_computers where device_id = $1", [phone.id])).rows[0].n).toBe(0);
    expect((await call(phone.token, "GET", "/v1/fleet")).statusCode).toBe(401);
    expect((await call(phone.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(401);
  });

  it("requires reproof and a new sealed descriptor after key rotation", async () => {
    const a = await account();
    const phone = await join(a);
    await publish(a.token);
    expect((await call(a.token, "PUT", "/v1/sync/keyrings/2", {
      recoveryWrap: vectors.recovery.blob, proof: proof(2), wraps: [a, phone].map((d) => ({ deviceId: d.id, wrap: vectors.wrap.blob })),
    })).statusCode).toBe(201);
    expect((await call(phone.token, "GET", "/v1/fleet")).statusCode).toBe(403);
    expect(await list(a.token)).toEqual([]);
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(409);
    expect((await publish(a.token, 2, 1)).statusCode).toBe(409);
    expect((await publish(a.token, 2, 2)).statusCode).toBe(200);
    await call(phone.token, "POST", "/v1/sync/keyrings/2/proof", { proof: proof(2) });
    expect((await list(phone.token))[0]).toMatchObject({ keyId: 2, revision: 2 });
  });

  it("stops publishing on downgrade but permits discovery and withdrawal", async () => {
    const a = await account();
    await publish(a.token);
    await db.query("update users set plan = 'free' where id = $1", [a.user]);
    expect((await publish(a.token, 2)).statusCode).toBe(402);
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(402);
    expect(await list(a.token)).toHaveLength(1);
    expect((await call(a.token, "DELETE", "/v1/fleet/self")).statusCode).toBe(204);
    expect(await list(a.token)).toEqual([]);
  });

  it("removes descriptors with sync deletion and account deletion", async () => {
    const a = await account();
    const other = await account();
    await publish(a.token);
    await publish(other.token);
    expect((await call(a.token, "DELETE", "/v1/sync")).statusCode).toBe(204);
    expect((await db.query("select count(*)::int as n from fleet_computers where user_id = $1", [a.user])).rows[0].n).toBe(0);
    await db.query("delete from users where id = $1", [other.user]);
    expect((await db.query("select count(*)::int as n from fleet_computers")).rows[0].n).toBe(0);
  });

  it("hides expired publisher tokens and missing wraps even before presence expires", async () => {
    const a = await account();
    const phone = await join(a);
    await publish(a.token);
    await db.query("update api_tokens set expires_at = now() - interval '1 second' where device_id = $1", [a.id]);
    expect(await list(phone.token)).toEqual([]);
    expect((await call(a.token, "POST", "/v1/fleet/self/heartbeat")).statusCode).toBe(401);
    await db.query("update api_tokens set expires_at = now() + interval '1 day' where device_id = $1", [a.id]);
    expect(await list(phone.token)).toHaveLength(1);
    await db.query("delete from sync_key_wraps where device_id = $1", [a.id]);
    expect(await list(phone.token)).toEqual([]);
    expect((await publish(a.token, 2)).statusCode).toBe(403);
  });

  it("rate limits fleet requests before token checks", async () => {
    const limited = buildServer({ db, allowedOrigins: [], fleetEnabled: true, syncRateLimit: { max: 1, windowMs: 60_000 } });
    try {
      expect((await limited.inject({ method: "GET", url: "/v1/fleet" })).statusCode).toBe(401);
      expect((await limited.inject({ method: "GET", url: "/v1/fleet" })).statusCode).toBe(429);
    } finally { await limited.close(); }
  });

  it("rejects an oversized request before storing it", async () => {
    const a = await account();
    expect((await publish(a.token, 1, 1, b64(24 * 1024))).statusCode).toBe(413);
    expect(await list(a.token)).toEqual([]);
  });

  it("caps retained advertisements per account", async () => {
    const a = await account();
    await db.query(
      `with d as (insert into sync_devices (user_id, public_key, label)
         select $1, decode('04' || lpad(to_hex(n), 128, '0'), 'hex'), 'fixture' from generate_series(1, $2) n returning id)
       insert into fleet_computers (user_id, device_id, key_id, revision, descriptor)
         select $1, id, 1, 1, $3 from d`,
      [a.user, MAX_FLEET_COMPUTERS, Buffer.from(sealed(), "base64url")],
    );
    expect((await publish(a.token)).json()).toEqual({ error: "fleet-full" });
  });
});
