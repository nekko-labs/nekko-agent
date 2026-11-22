import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { purgeLibraryHistory } from "./shares.js";
import { SYNC_QUOTA } from "./sync.js";
import { pgliteDb } from "./test-db.js";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));

let db: Db;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  app = buildServer({ db, allowedOrigins: [] });
});
afterEach(async () => { await app.close(); await db.close(); });

const b64 = (n: number) => randomBytes(n).toString("base64url");
/** A sealed file as the app makes one: opaque bytes to the service. */
const sealedFile = (n = 200) => b64(n);

async function user(email: string, plan: "free" | "pro" | "team" = "pro") {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, $2, true) returning id", [email, plan]);
  return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
}
const call = (token: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload });
const setLibrary = (staff: string, state: "off" | "team" | "on") => call(staff, "PUT", "/v1/staff/features/library-cloud", { state });

describe("the library switches", () => {
  it("start off, list both, and only library-cloud can run on this service", async () => {
    const philip = await user("philip@nekkolabs.com");
    const staff = (await call(philip.token, "GET", "/v1/staff/features")).json();
    expect(staff.features).toMatchObject({ "library-cloud": "off", "library-multiplayer": "off" });
    expect(staff.available).toContain("library-cloud");
    expect(staff.available).not.toContain("library-multiplayer");
    expect((await call(philip.token, "PUT", "/v1/staff/features/library-multiplayer", { state: "on" })).statusCode).toBe(200);
    // Switched on, multiplayer still isn't offered: the service has no relay yet.
    expect((await call(null, "GET", "/v1/features")).json().features["library-multiplayer"]).toBe(false);
  });
});

describe("shared Library files", () => {
  it("are hidden until the switch reaches the account, and need Pro or Enterprise to write", async () => {
    const philip = await user("philip@nekkolabs.com");
    const someone = await user("someone@example.com");
    const free = await user("davide@nekkolabs.com", "free");
    expect((await call(philip.token, "POST", "/v1/shares", { blob: sealedFile() })).statusCode).toBe(404);
    await setLibrary(philip.token, "team");
    expect((await call(philip.token, "POST", "/v1/shares", { blob: sealedFile() })).statusCode).toBe(201);
    expect((await call(someone.token, "POST", "/v1/shares", { blob: sealedFile() })).statusCode).toBe(404);
    expect((await call(free.token, "POST", "/v1/shares", { blob: sealedFile() })).json()).toEqual({ error: "plan-required", plan: "free", needs: ["pro", "team"] });
    await setLibrary(philip.token, "on");
    expect((await call(someone.token, "POST", "/v1/shares", { blob: sealedFile() })).statusCode).toBe(201);
    expect((await call(null, "POST", "/v1/shares", { blob: sealedFile() })).statusCode).toBe(401);
  });

  it("serve their sealed bytes to anyone with the id, from any site, and list only for the owner", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    const blob = sealedFile(500);
    const made = await call(philip.token, "POST", "/v1/shares", { blob });
    const { id } = made.json();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const open = await call(null, "GET", `/v1/s/${id}`);
    expect(open.json()).toEqual({ id, revision: 1, blob });
    expect(open.headers["access-control-allow-origin"]).toBe("*");
    expect((await call(null, "GET", `/v1/s/${b64(16)}`)).statusCode).toBe(404);
    expect((await call(null, "GET", "/v1/s/..%2F..%2Fetc")).statusCode).toBe(404);
    const list = (await call(philip.token, "GET", "/v1/shares")).json();
    expect(list).toMatchObject({ keptDays: 30, shares: [{ id, revision: 1, size: 500, canEdit: false, deletedAt: null }] });
    const other = await user("other@example.com");
    expect((await call(other.token, "GET", "/v1/shares")).json().shares).toEqual([]);
    // The bytes never pass through anything but the database as they came.
    const { rows } = await db.query<{ blob: Buffer }>("select blob from library_shares where id = $1", [id]);
    expect(Buffer.from(rows[0].blob).toString("base64url")).toBe(blob);
  });

  it("refuse malformed and oversized files", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    for (const bad of [{}, { blob: "" }, { blob: b64(10) }, { blob: "not base64!" }, { blob: sealedFile(), editHash: b64(16) }]) {
      expect((await call(philip.token, "POST", "/v1/shares", bad)).statusCode).toBe(400);
    }
  });

  it("change by revision, keep the old one as a version, and go back to it", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    const [v1, v2] = [sealedFile(), sealedFile()];
    const { id } = (await call(philip.token, "POST", "/v1/shares", { blob: v1 })).json();
    expect((await call(philip.token, "PUT", `/v1/shares/${id}`, { blob: v2, revision: 1 })).json()).toEqual({ id, revision: 2 });
    // Someone else wrote first: the stale writer is told the revision to catch up to.
    expect((await call(philip.token, "PUT", `/v1/shares/${id}`, { blob: sealedFile(), revision: 1 })).json()).toEqual({ error: "conflict", revision: 2 });
    const versions = (await call(philip.token, "GET", `/v1/shares/${id}/versions`)).json();
    expect(versions).toMatchObject({ current: { revision: 2 }, versions: [{ revision: 1 }], keptDays: 30 });
    expect((await call(philip.token, "GET", `/v1/shares/${id}/versions/1`)).json().blob).toBe(v1);
    expect((await call(philip.token, "POST", `/v1/shares/${id}/versions/1/restore`)).json()).toEqual({ id, revision: 3 });
    expect((await call(null, "GET", `/v1/s/${id}`)).json()).toMatchObject({ revision: 3, blob: v1 });
    expect((await call(philip.token, "GET", `/v1/shares/${id}/versions`)).json().versions.map((v: { revision: number }) => v.revision)).toEqual([2, 1]);
    // Viewers see the newest only.
    expect((await call(null, "GET", `/v1/shares/${id}/versions`)).statusCode).toBe(401);
  });

  it("let an edit link's token change the file, and nobody else", async () => {
    const philip = await user("philip@nekkolabs.com");
    const stranger = await user("stranger@example.com");
    await setLibrary(philip.token, "on");
    const token = b64(32);
    const editHash = createHash("sha256").update(token).digest("base64url");
    const { id } = (await call(philip.token, "POST", "/v1/shares", { blob: sealedFile(), editHash })).json();
    expect((await call(null, "PUT", `/v1/shares/${id}`, { blob: sealedFile(), revision: 1 }, { "x-nekko-share-edit": token })).json()).toEqual({ id, revision: 2 });
    expect((await call(null, "GET", `/v1/shares/${id}/versions`, undefined, { "x-nekko-share-edit": token })).statusCode).toBe(200);
    expect((await call(null, "PUT", `/v1/shares/${id}`, { blob: sealedFile(), revision: 2 }, { "x-nekko-share-edit": b64(32) })).statusCode).toBe(401);
    expect((await call(stranger.token, "PUT", `/v1/shares/${id}`, { blob: sealedFile(), revision: 2 })).statusCode).toBe(404);
    // A view-only share takes no token at all.
    const viewOnly = (await call(philip.token, "POST", "/v1/shares", { blob: sealedFile() })).json().id;
    expect((await call(null, "PUT", `/v1/shares/${viewOnly}`, { blob: sealedFile(), revision: 1 }, { "x-nekko-share-edit": token })).statusCode).toBe(401);
    // Only the owner deletes or restores, token or not.
    expect((await call(stranger.token, "DELETE", `/v1/shares/${id}`)).statusCode).toBe(404);
    expect((await call(null, "DELETE", `/v1/shares/${id}`, undefined, { "x-nekko-share-edit": token })).statusCode).toBe(401);
  });

  it("stop at once when deleted, come back on restore, and go for good when asked", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    const { id } = (await call(philip.token, "POST", "/v1/shares", { blob: sealedFile() })).json();
    expect((await call(philip.token, "DELETE", `/v1/shares/${id}`)).statusCode).toBe(204);
    expect((await call(null, "GET", `/v1/s/${id}`)).json()).toEqual({ error: "no-longer-shared" });
    expect((await call(philip.token, "PUT", `/v1/shares/${id}`, { blob: sealedFile(), revision: 1 })).statusCode).toBe(410);
    expect((await call(philip.token, "GET", "/v1/shares")).json().shares[0].deletedAt).not.toBeNull();
    expect((await call(philip.token, "POST", `/v1/shares/${id}/restore`)).statusCode).toBe(200);
    expect((await call(null, "GET", `/v1/s/${id}`)).statusCode).toBe(200);
    expect((await call(philip.token, "DELETE", `/v1/shares/${id}?forever=1`)).statusCode).toBe(204);
    expect((await call(null, "GET", `/v1/s/${id}`)).statusCode).toBe(404);
    expect((await db.query("select 1 from library_shares", [])).rows).toEqual([]);
  });

  it("count toward the plan's storage, and a write past it changes nothing", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    await db.query("insert into sync_usage (user_id, bytes) values ($1, $2)", [philip.id, SYNC_QUOTA.pro - 100]);
    expect((await call(philip.token, "POST", "/v1/shares", { blob: sealedFile(200) })).json()).toEqual({ error: "quota", limit: SYNC_QUOTA.pro });
    expect((await db.query("select 1 from library_shares", [])).rows).toEqual([]);
  });

  it("go with the account", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setLibrary(philip.token, "on");
    await call(philip.token, "POST", "/v1/shares", { blob: sealedFile() });
    await db.query("delete from users where id = $1", [philip.id]);
    expect((await db.query("select 1 from library_shares", [])).rows).toEqual([]);
  });
});

describe("synced Library history", () => {
  async function keyedDevice(token: string) {
    const dev = await call(token, "POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Mac" });
    const deviceId = dev.json().deviceId as string;
    const proof = vectors.epochProofs.find((p: { keyId: number }) => p.keyId === 1)?.proof ?? b64(32);
    expect((await call(token, "PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, proof, wraps: [{ deviceId, wrap: vectors.wrap.blob }] })).statusCode).toBe(201);
  }
  const push = (token: string, collection: string, objectId: string, revision: number, blob: string) =>
    call(token, "POST", "/v1/sync/push", { objects: [{ collection, objectId, revision, keyId: 1, blob }] });

  it("keeps a Library file's replaced revisions (a delete is just another), and not a chat's", async () => {
    const u = await user("me@example.com");
    await keyedDevice(u.token);
    const file = b64(32), chat = b64(32);
    for (let r = 1; r <= 3; r++) expect((await push(u.token, "library", file, r, vectors.records[1].blob)).json().results[0].status).toBe("ok");
    await push(u.token, "chat", chat, 1, vectors.records[1].blob);
    await push(u.token, "chat", chat, 2, vectors.records[2].blob);
    const history = (await call(u.token, "GET", `/v1/sync/history/library/${file}`)).json();
    expect(history.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    expect((await call(u.token, "GET", `/v1/sync/history/library/${file}/1`)).json()).toMatchObject({ revision: 1, keyId: 1, blob: vectors.records[1].blob });
    expect((await call(u.token, "GET", `/v1/sync/history/chat/${chat}`)).statusCode).toBe(404);
    expect((await db.query("select 1 from sync_object_history where collection = 'chat'", [])).rows).toEqual([]);
    // Kept revisions count toward storage: three copies of the blob.
    const size = Buffer.from(vectors.records[1].blob, "base64url").length;
    const { rows } = await db.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [u.id]);
    expect(Number(rows[0].bytes)).toBe(size * 3 + Buffer.from(vectors.records[2].blob, "base64url").length);
    // Another account sees none of it, and deleting everything synced takes it.
    const other = await user("other@example.com");
    expect((await call(other.token, "GET", `/v1/sync/history/library/${file}`)).json().revisions).toEqual([]);
    expect((await call(u.token, "DELETE", "/v1/sync")).statusCode).toBe(204);
    expect((await db.query("select 1 from sync_object_history", [])).rows).toEqual([]);
  });

  it("drops what is more than 30 days old, and frees its storage", async () => {
    const u = await user("philip@nekkolabs.com");
    await keyedDevice(u.token);
    await setLibrary(u.token, "on");
    const file = b64(32);
    for (let r = 1; r <= 3; r++) await push(u.token, "library", file, r, vectors.records[1].blob);
    const { id: kept } = (await call(u.token, "POST", "/v1/shares", { blob: sealedFile() })).json();
    await call(u.token, "PUT", `/v1/shares/${kept}`, { blob: sealedFile(), revision: 1 });
    const { id: gone } = (await call(u.token, "POST", "/v1/shares", { blob: sealedFile() })).json();
    await call(u.token, "DELETE", `/v1/shares/${gone}`);
    const before = Number((await db.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [u.id])).rows[0].bytes);
    // Revision 1 and the share's first version were replaced 31 days ago; revision 2 yesterday.
    await db.query("update sync_object_history set superseded_at = now() - interval '31 days' where revision = 1", []);
    await db.query("update sync_object_history set superseded_at = now() - interval '1 day' where revision = 2", []);
    await db.query("update library_share_versions set superseded_at = now() - interval '31 days'", []);
    await db.query("update library_shares set deleted_at = now() - interval '31 days' where id = $1", [gone]);
    expect(await purgeLibraryHistory(db)).toEqual({ revisions: 1, versions: 1, shares: 1 });
    expect((await call(u.token, "GET", `/v1/sync/history/library/${file}`)).json().revisions.map((r: { revision: number }) => r.revision)).toEqual([2]);
    expect((await call(null, "GET", `/v1/s/${kept}`)).statusCode).toBe(200);
    expect((await db.query("select 1 from library_shares where id = $1", [gone])).rows).toEqual([]);
    const after = Number((await db.query<{ bytes: string }>("select bytes from sync_usage where user_id = $1", [u.id])).rows[0].bytes);
    expect(before - after).toBe(Buffer.from(vectors.records[1].blob, "base64url").length);
    expect(await purgeLibraryHistory(db)).toEqual({ revisions: 0, versions: 0, shares: 0 });
  });
});
