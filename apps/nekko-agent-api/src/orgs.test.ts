import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { MAX_DESCRIPTOR_BYTES } from "./fleet.js";
import { migrate } from "./migrate.js";
import { MAX_ORG_COMPUTERS, MAX_ORG_MEMBERS, MAX_ORGS_PER_USER } from "./orgs.js";
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
  app = buildServer({ db, allowedOrigins: [], orgsEnabled: true });
});
afterEach(async () => { await app.close(); await db.close(); });

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
function call(token: string, method: Method, url: string, payload?: object) {
  return app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}
async function device(token: string) {
  const r = await call(token, "POST", "/v1/sync/devices", {
    publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Test device",
  });
  expect(r.statusCode).toBe(201);
  return r.json().deviceId as string;
}
interface Account { user: string; email: string; token: string; id: string }
/** A signed-in, unlocked account: a device holding epoch 1 and proof of it. */
async function account(plan = "pro", email = `${b64(8)}@example.com`): Promise<Account> {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan) values ($1, $2) returning id", [email, plan]);
  const token = await issueToken(db, rows[0].id);
  // A free account cannot register a sync device, so it stays signed in only.
  if (plan === "free") return { user: rows[0].id, email, token, id: "" };
  const id = await device(token);
  expect((await call(token, "PUT", "/v1/sync/keyrings/1", {
    recoveryWrap: vectors.recovery.blob, proof: proof(1), wraps: [{ deviceId: id, wrap: vectors.wrap.blob }],
  })).statusCode).toBe(201);
  return { user: rows[0].id, email, token, id };
}
/** An account that only signed in: it has a live token but no device that holds the keys. */
async function bareToken(a: Account) { return issueToken(db, a.user); }
/** A second device of the same account, unlocked. */
async function join(a: Account) {
  const token = await issueToken(db, a.user);
  const id = await device(token);
  expect((await call(a.token, "PUT", `/v1/sync/keyrings/1/wraps/${id}`, { wrap: vectors.wrap.blob })).statusCode).toBe(204);
  expect((await call(token, "POST", "/v1/sync/keyrings/1/proof", { proof: proof(1) })).statusCode).toBe(204);
  return { token, id };
}
async function createOrg(a: Account, name = "Nekko Labs", key = true): Promise<string> {
  const r = await call(a.token, "POST", "/v1/orgs", { name });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  if (key) expect((await call(a.token, "PUT", `/v1/orgs/${id}/key`, { keyId: 1 })).statusCode).toBe(200);
  return id;
}
async function invite(owner: Account, orgId: string, who: Account, role = "member") {
  const r = await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: who.email, role });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
async function addMember(owner: Account, orgId: string, who: Account, role = "member") {
  const id = await invite(owner, orgId, who, role);
  expect((await call(who.token, "POST", `/v1/orgs/invites/${id}/accept`)).statusCode).toBe(200);
}
const publish = (token: string, orgId: string, revision = 1, orgKeyId = 1, descriptor = sealed()) =>
  call(token, "PUT", `/v1/orgs/${orgId}/fleet/self`, { orgKeyId, revision, descriptor });
const fleet = async (token: string, orgId: string) => (await call(token, "GET", `/v1/orgs/${orgId}/fleet`)).json().computers;
const rows = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n;

describe("organizations: gating", () => {
  it("is absent unless explicitly enabled", async () => {
    const off = buildServer({ db, allowedOrigins: [] });
    try {
      for (const [method, url] of [["GET", "/v1/orgs"], ["POST", "/v1/orgs"], ["GET", `/v1/orgs/${randomUUID()}/fleet`], ["POST", `/v1/orgs/invites/${randomUUID()}/accept`]] as const) {
        expect((await off.inject({ method, url })).statusCode).toBe(404);
      }
    } finally { await off.close(); }
  });

  it("is independent of the account fleet flag", async () => {
    const fleetOnly = buildServer({ db, allowedOrigins: [], fleetEnabled: true });
    const orgsOnly = buildServer({ db, allowedOrigins: [], orgsEnabled: true });
    try {
      expect((await fleetOnly.inject({ method: "GET", url: "/v1/orgs" })).statusCode).toBe(404);
      expect((await fleetOnly.inject({ method: "GET", url: "/v1/fleet" })).statusCode).toBe(401);
      expect((await orgsOnly.inject({ method: "GET", url: "/v1/fleet" })).statusCode).toBe(404);
      expect((await orgsOnly.inject({ method: "GET", url: "/v1/orgs" })).statusCode).toBe(401);
    } finally { await fleetOnly.close(); await orgsOnly.close(); }
  });

  it("requires a bearer token and sends no-store", async () => {
    const a = await account();
    expect((await call("", "GET", "/v1/orgs")).statusCode).toBe(401);
    expect((await call("nk_" + b64(32), "POST", "/v1/orgs", { name: "X" })).statusCode).toBe(401);
    expect((await call(a.token, "GET", "/v1/orgs")).headers["cache-control"]).toBe("no-store");
  });

  it("limits create, accept and the org fleet to the allowlist, compared lower-case", async () => {
    const owner = await account("pro", "Philip@NekkoLabs.com");
    const other = await account("pro", "someone@example.com");
    await app.close();
    app = buildServer({ db, allowedOrigins: [], orgsEnabled: true, orgsAllowedEmails: ["philip@nekkolabs.com"] });
    const orgId = await createOrg(owner);
    // Not allowed: create, accept, and every org fleet call. Reading one's own orgs and invites stays open.
    expect((await call(other.token, "POST", "/v1/orgs", { name: "Nope" })).json()).toEqual({ error: "orgs-not-available" });
    expect((await call(other.token, "POST", "/v1/orgs", { name: "Nope" })).statusCode).toBe(403);
    const inviteId = await invite(owner, orgId, other);
    expect((await call(other.token, "GET", "/v1/orgs")).json().invites).toHaveLength(1);
    expect((await call(other.token, "POST", `/v1/orgs/invites/${inviteId}/accept`)).json()).toEqual({ error: "orgs-not-available" });
    expect((await call(other.token, "GET", `/v1/orgs/${orgId}/fleet`)).statusCode).toBe(403);
    expect((await publish(other.token, orgId)).json()).toEqual({ error: "orgs-not-available" });
    expect((await call(other.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(403);
    expect(await rows("select count(*)::int as n from org_members where user_id = $1", [other.user])).toBe(0);
    // Allowed accounts work end to end.
    expect((await publish(owner.token, orgId)).statusCode).toBe(201);
    expect(await fleet(owner.token, orgId)).toHaveLength(1);
  });

  it("allows everyone when the allowlist is unset or empty", async () => {
    const a = await account();
    await app.close();
    app = buildServer({ db, allowedOrigins: [], orgsEnabled: true, orgsAllowedEmails: [] });
    expect((await call(a.token, "POST", "/v1/orgs", { name: "Open" })).statusCode).toBe(201);
  });

  it("needs a sync plan to create an org, but any plan to read, and any plan to be a member", async () => {
    const free = await account("free");
    expect((await call(free.token, "POST", "/v1/orgs", { name: "No" })).json()).toMatchObject({ error: "plan-required", plan: "free" });
    expect((await call(free.token, "GET", "/v1/orgs")).json()).toEqual({ orgs: [], invites: [] });
    const owner = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, free);
    expect((await call(free.token, "GET", `/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });
});

describe("organizations: orgs and roles", () => {
  it("creates, lists, gets, renames and deletes an org", async () => {
    const a = await account();
    const created = await call(a.token, "POST", "/v1/orgs", { name: "  Nekko   Labs " });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Nekko Labs", role: "owner", keyId: 0, memberCount: 1 });
    expect(Object.keys(created.json()).sort()).toEqual(["createdAt", "id", "keyId", "memberCount", "name", "role"]);
    const id = created.json().id;
    expect((await call(a.token, "GET", "/v1/orgs")).json().orgs).toEqual([created.json()]);
    const got = (await call(a.token, "GET", `/v1/orgs/${id}`)).json();
    expect(got).toMatchObject({ id, name: "Nekko Labs", role: "owner", invites: [] });
    expect(got.members).toEqual([{ userId: a.user, email: a.email, role: "owner", addedAt: expect.any(String), you: true }]);
    const renamed = await call(a.token, "PATCH", `/v1/orgs/${id}`, { name: "Nekko" });
    expect(renamed.json()).toMatchObject({ id, name: "Nekko" });
    expect((await call(a.token, "DELETE", `/v1/orgs/${id}`)).statusCode).toBe(204);
    expect((await call(a.token, "GET", `/v1/orgs/${id}`)).statusCode).toBe(404);
    expect((await call(a.token, "GET", "/v1/orgs")).json().orgs).toEqual([]);
  });

  it("rejects bad names", async () => {
    const a = await account();
    for (const name of ["", "   ", "x".repeat(81), 5, null, "bad\u0007name", "a\u0000b"]) {
      expect((await call(a.token, "POST", "/v1/orgs", { name })).json()).toEqual({ error: "bad-name" });
    }
    expect((await call(a.token, "POST", "/v1/orgs", { name: "x".repeat(80) })).statusCode).toBe(201);
    const id = await createOrg(a, "Ok");
    expect((await call(a.token, "PATCH", `/v1/orgs/${id}`, { name: "" })).statusCode).toBe(400);
  });

  it("caps orgs per user", async () => {
    const a = await account();
    for (let i = 0; i < MAX_ORGS_PER_USER; i++) expect((await call(a.token, "POST", "/v1/orgs", { name: `Org ${i}` })).statusCode).toBe(201);
    expect((await call(a.token, "POST", "/v1/orgs", { name: "One more" })).json()).toEqual({ error: "org-limit" });
  });

  it("gives non-members a 404 on every org route and reveals nothing", async () => {
    const owner = await account();
    const stranger = await account();
    const orgId = await createOrg(owner);
    const fake = randomUUID();
    const routes: [Method, string, object?][] = [
      ["GET", `/v1/orgs/${orgId}`], ["PATCH", `/v1/orgs/${orgId}`, { name: "x" }], ["DELETE", `/v1/orgs/${orgId}`],
      ["POST", `/v1/orgs/${orgId}/invites`, { email: "a@b.co" }], ["DELETE", `/v1/orgs/${orgId}/invites/${fake}`],
      ["DELETE", `/v1/orgs/${orgId}/members/${owner.user}`], ["PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 }],
      ["GET", `/v1/orgs/${orgId}/fleet`], ["PUT", `/v1/orgs/${orgId}/fleet/self`, { orgKeyId: 1, revision: 1, descriptor: sealed() }],
      ["POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`], ["DELETE", `/v1/orgs/${orgId}/fleet/self`],
    ];
    for (const [method, url, body] of routes) {
      const real = await call(stranger.token, method, url, body);
      const missing = await call(stranger.token, method, url.replace(orgId, fake), body);
      expect([method, url, real.statusCode]).toEqual([method, url, 404]);
      expect(real.json()).toEqual(missing.json());
    }
    expect((await call(stranger.token, "GET", "/v1/orgs/not-a-uuid")).statusCode).toBe(404);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });

  it("limits what members and admins may do", async () => {
    const owner = await account();
    const admin = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, admin, "admin");
    await addMember(owner, orgId, member, "member");
    expect((await call(admin.token, "GET", `/v1/orgs/${orgId}`)).json().role).toBe("admin");
    // A member cannot rename, invite, revoke, delete or advance the key, and sees no invites.
    const pending = await invite(owner, orgId, await account());
    expect((await call(member.token, "PATCH", `/v1/orgs/${orgId}`, { name: "Mine" })).json()).toEqual({ error: "forbidden" });
    expect((await call(member.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "x@example.com" })).statusCode).toBe(403);
    expect((await call(member.token, "DELETE", `/v1/orgs/${orgId}/invites/${pending}`)).statusCode).toBe(403);
    expect((await call(member.token, "DELETE", `/v1/orgs/${orgId}`)).statusCode).toBe(403);
    expect((await call(member.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 })).statusCode).toBe(403);
    expect((await call(member.token, "GET", `/v1/orgs/${orgId}`)).json().invites).toEqual([]);
    expect((await call(admin.token, "GET", `/v1/orgs/${orgId}`)).json().invites).toHaveLength(1);
    // An admin can rename and invite, but not delete the org.
    expect((await call(admin.token, "PATCH", `/v1/orgs/${orgId}`, { name: "Renamed" })).statusCode).toBe(200);
    expect((await call(admin.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "y@example.com" })).statusCode).toBe(201);
    expect((await call(admin.token, "DELETE", `/v1/orgs/${orgId}`)).statusCode).toBe(403);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().memberCount).toBe(3);
  });
});

describe("organizations: invites", () => {
  it("shows an invite to the invitee by email, and only that email may accept it", async () => {
    const owner = await account();
    const invitee = await account("pro", "Invitee@Example.com");
    const other = await account();
    const orgId = await createOrg(owner, "Acme");
    const made = await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "  INVITEE@example.com ", role: "admin" });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ email: "invitee@example.com", role: "admin" });
    expect(Date.parse(made.json().expiresAt) - Date.parse(made.json().createdAt)).toBeGreaterThan(13.9 * 86400_000);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().invites).toEqual([made.json()]);
    const listed = (await call(invitee.token, "GET", "/v1/orgs")).json();
    expect(listed.orgs).toEqual([]);
    expect(listed.invites).toEqual([{ id: made.json().id, orgId, orgName: "Acme", role: "admin", invitedBy: owner.email, expiresAt: made.json().expiresAt }]);
    expect((await call(other.token, "GET", "/v1/orgs")).json().invites).toEqual([]);
    expect((await call(other.token, "POST", `/v1/orgs/invites/${made.json().id}/accept`)).statusCode).toBe(404);
    expect(await rows("select count(*)::int as n from org_members where org_id = $1", [orgId])).toBe(1);
    const accepted = await call(invitee.token, "POST", `/v1/orgs/invites/${made.json().id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: orgId, name: "Acme", role: "admin", memberCount: 2 });
    expect((await call(invitee.token, "GET", "/v1/orgs")).json()).toMatchObject({ invites: [], orgs: [{ id: orgId }] });
    expect((await call(invitee.token, "POST", `/v1/orgs/invites/${made.json().id}/accept`)).statusCode).toBe(404);
  });

  it("does not accept or list an expired invite, and replaces it with a fresh one", async () => {
    const owner = await account();
    const invitee = await account();
    const orgId = await createOrg(owner);
    const id = await invite(owner, orgId, invitee);
    await db.query("update org_invites set expires_at = now() - interval '1 second'");
    expect((await call(invitee.token, "GET", "/v1/orgs")).json().invites).toEqual([]);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().invites).toEqual([]);
    expect((await call(invitee.token, "POST", `/v1/orgs/invites/${id}/accept`)).json()).toEqual({ error: "invite-expired" });
    const fresh = await invite(owner, orgId, invitee);
    expect(fresh).not.toBe(id);
    expect((await call(invitee.token, "POST", `/v1/orgs/invites/${fresh}/accept`)).statusCode).toBe(200);
  });

  it("revokes an invite, and refuses duplicates, members, bad emails and bad roles", async () => {
    const owner = await account();
    const invitee = await account();
    const orgId = await createOrg(owner);
    const id = await invite(owner, orgId, invitee);
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: invitee.email })).json()).toEqual({ error: "invite-exists" });
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/invites/${id}`)).statusCode).toBe(204);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/invites/${id}`)).statusCode).toBe(404);
    expect((await call(invitee.token, "POST", `/v1/orgs/invites/${id}/accept`)).statusCode).toBe(404);
    expect((await call(invitee.token, "GET", "/v1/orgs")).json().invites).toEqual([]);
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: owner.email })).json()).toEqual({ error: "already-member" });
    for (const email of ["", "nope", "a@b", 5, "a b@c.de"]) {
      expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email })).json()).toEqual({ error: "bad-email" });
    }
    for (const role of ["owner", "root", 1]) {
      expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "z@example.com", role })).json()).toEqual({ error: "bad-role" });
    }
    // A revoke only reaches that org's own invites.
    const otherOrg = await createOrg(owner, "Other");
    const elsewhere = await invite(owner, otherOrg, invitee);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/invites/${elsewhere}`)).statusCode).toBe(404);
  });

  it("caps members per org, counting open invites", async () => {
    const owner = await account();
    const orgId = await createOrg(owner);
    await db.query(
      `with u as (insert into users (email) select 'fill' || n || '@example.com' from generate_series(1, $2::int) n returning id)
       insert into org_members (org_id, user_id, role) select $1, id, 'member' from u`,
      [orgId, MAX_ORG_MEMBERS - 2],
    );
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "last@example.com" })).statusCode).toBe(201);
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/invites`, { email: "over@example.com" })).json()).toEqual({ error: "org-full" });
    // Filling the org with a different member after the invite leaves the invite unusable.
    await db.query("insert into users (email) values ('slot@example.com')");
    await db.query("insert into org_members (org_id, user_id, role) select $1, id, 'member' from users where email = 'slot@example.com'", [orgId]);
    const late = await account("pro", "last@example.com");
    const id = (await call(late.token, "GET", "/v1/orgs")).json().invites[0].id;
    expect((await call(late.token, "POST", `/v1/orgs/invites/${id}/accept`)).json()).toEqual({ error: "org-full" });
  });
});

describe("organizations: members", () => {
  it("removes a member, answers rotateKey and drops their computers", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    await publish(owner.token, orgId);
    await publish(member.token, orgId);
    expect(await fleet(owner.token, orgId)).toHaveLength(2);
    const removed = await call(owner.token, "DELETE", `/v1/orgs/${orgId}/members/${member.user}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ rotateKey: true });
    expect(await fleet(owner.token, orgId)).toHaveLength(1);
    expect(await rows("select count(*)::int as n from org_fleet_computers where user_id = $1", [member.user])).toBe(0);
    expect((await call(member.token, "GET", `/v1/orgs/${orgId}`)).statusCode).toBe(404);
    expect((await call(member.token, "GET", `/v1/orgs/${orgId}/fleet`)).statusCode).toBe(404);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/members/${member.user}`)).statusCode).toBe(404);
    // The server does not rotate the key by itself.
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().keyId).toBe(1);
  });

  it("hides a removed member's computer even if its row survived", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    await publish(member.token, orgId);
    await db.query("delete from org_members where user_id = $1", [member.user]);
    expect(await fleet(owner.token, orgId)).toEqual([]);
  });

  it("lets a member leave, but never leaves an org without an owner", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    await publish(member.token, orgId);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/members/${owner.user}`)).json()).toEqual({ error: "last-owner" });
    expect((await call(member.token, "DELETE", `/v1/orgs/${orgId}/members/${member.user}`)).json()).toEqual({ rotateKey: true });
    expect(await fleet(owner.token, orgId)).toEqual([]);
    expect((await call(member.token, "GET", "/v1/orgs")).json().orgs).toEqual([]);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().memberCount).toBe(1);
    expect(await rows("select count(*)::int as n from org_members where org_id = $1 and role = 'owner'", [orgId])).toBe(1);
  });

  it("lets a second owner leave, and orders who may remove whom", async () => {
    const owner = await account();
    const admin = await account();
    const admin2 = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, admin, "admin");
    await addMember(owner, orgId, admin2, "admin");
    await addMember(owner, orgId, member);
    expect((await call(member.token, "DELETE", `/v1/orgs/${orgId}/members/${admin.user}`)).statusCode).toBe(403);
    expect((await call(admin.token, "DELETE", `/v1/orgs/${orgId}/members/${owner.user}`)).statusCode).toBe(403);
    expect((await call(admin.token, "DELETE", `/v1/orgs/${orgId}/members/${admin2.user}`)).statusCode).toBe(403);
    expect((await call(admin.token, "DELETE", `/v1/orgs/${orgId}/members/${member.user}`)).statusCode).toBe(200);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/members/${admin2.user}`)).statusCode).toBe(200);
    expect((await call(admin.token, "DELETE", `/v1/orgs/${orgId}/members/${admin.user}`)).statusCode).toBe(200);
    expect((await call(owner.token, "DELETE", `/v1/orgs/${orgId}/members/not-a-uuid`)).statusCode).toBe(404);
  });
});

describe("organizations: org key epoch", () => {
  it("advances by exactly one, for owners and admins who are unlocked", async () => {
    const owner = await account();
    const admin = await account();
    const orgId = await createOrg(owner, "Keys", false);
    await addMember(owner, orgId, admin, "admin");
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().keyId).toBe(0);
    for (const keyId of [0, 2, 3, -1, 1.5, "1", null]) {
      const r = await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId });
      expect(r.statusCode === 409 || r.statusCode === 400).toBe(true);
    }
    expect((await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 })).json()).toEqual({ error: "org-key-epoch", currentKeyId: 0 });
    expect((await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 1, proof: "ignored" })).json()).toEqual({ keyId: 1 });
    expect((await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 1 })).json()).toEqual({ error: "org-key-epoch", currentKeyId: 1 });
    expect((await call(admin.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 })).statusCode).toBe(200);
    expect((await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 3, extra: 1 })).statusCode).toBe(400);
    expect((await call(admin.token, "GET", "/v1/orgs")).json().orgs[0].keyId).toBe(2);
  });

  it("requires an unlocked device: sign-in alone is not enough", async () => {
    const owner = await account();
    const orgId = await createOrg(owner);
    const bare = await bareToken(owner);
    expect((await call(bare, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 })).json()).toEqual({ error: "needs-synced-device" });
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}`)).json().keyId).toBe(1);
  });

  it("hides computers of an older org-key epoch until they republish", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    await publish(owner.token, orgId);
    await publish(member.token, orgId);
    expect(await fleet(owner.token, orgId)).toHaveLength(2);
    expect((await call(owner.token, "PUT", `/v1/orgs/${orgId}/key`, { keyId: 2 })).statusCode).toBe(200);
    expect((await call(owner.token, "GET", `/v1/orgs/${orgId}/fleet`)).json()).toEqual({ orgKeyId: 2, computers: [] });
    expect(await rows("select count(*)::int as n from org_fleet_computers")).toBe(2);
    expect((await call(member.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).json()).toEqual({ error: "publish-required" });
    expect((await publish(member.token, orgId, 2, 1)).json()).toEqual({ error: "org-key-epoch", currentKeyId: 2 });
    expect((await publish(member.token, orgId, 2, 2)).statusCode).toBe(200);
    const list = await fleet(owner.token, orgId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ deviceId: member.id, orgKeyId: 2, revision: 2, you: false });
  });
});

describe("organizations: computers", () => {
  it("requires membership and an unlocked device, not just sign-in", async () => {
    const owner = await account();
    const orgId = await createOrg(owner);
    const bare = await bareToken(owner);
    const waiting = await issueToken(db, owner.user);
    await device(waiting);
    for (const token of [bare, waiting]) {
      expect((await call(token, "GET", `/v1/orgs/${orgId}/fleet`)).json()).toEqual({ error: "needs-synced-device" });
      expect((await publish(token, orgId)).json()).toEqual({ error: "needs-synced-device" });
      expect((await call(token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(403);
    }
    expect((await call("", "GET", `/v1/orgs/${orgId}/fleet`)).statusCode).toBe(401);
    // Once the device proves it holds the epoch it works.
    expect((await call(waiting, "PUT", `/v1/sync/keyrings/1/wraps/${(await call(waiting, "GET", "/v1/auth/me")).json().device}`, { wrap: vectors.wrap.blob, proof: proof(1) })).statusCode).toBe(204);
    expect((await publish(waiting, orgId)).statusCode).toBe(201);
    const r = await call(owner.token, "GET", `/v1/orgs/${orgId}/fleet`);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json().computers).toHaveLength(1);
  });

  it("publishes, lists with server-owned identity, heartbeats and expires presence", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    const descriptor = sealed();
    const first = await publish(owner.token, orgId, 1, 1, descriptor);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ deviceId: owner.id, orgKeyId: 1, revision: 1, leaseSeconds: 90 });
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).json()).toEqual({ leaseSeconds: 90 });
    const seen = await fleet(member.token, orgId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ deviceId: owner.id, userId: owner.user, orgKeyId: 1, revision: 1, descriptor, online: true, you: false });
    expect(Date.parse(seen[0].expiresAt) - Date.parse(seen[0].seenAt)).toBe(90_000);
    expect((await fleet(owner.token, orgId))[0].you).toBe(true);
    const phone = await join(owner);
    expect((await fleet(phone.token, orgId))[0].you).toBe(false);
    await db.query("update org_fleet_computers set seen_at = now() - interval '91 seconds'");
    expect((await fleet(member.token, orgId))[0].online).toBe(false);
    expect((await call(owner.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(200);
    expect((await fleet(member.token, orgId))[0]).toMatchObject({ online: true, revision: 1 });
    expect((await call(phone.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).json()).toEqual({ error: "publish-required" });
    // Identity only from the token: a body device or user id is refused.
    const spoof = await call(phone.token, "PUT", `/v1/orgs/${orgId}/fleet/self`, { orgKeyId: 1, revision: 1, descriptor, deviceId: owner.id });
    expect(spoof.statusCode).toBe(400);
    expect((await call(phone.token, "DELETE", `/v1/orgs/${orgId}/fleet/${owner.id}`)).statusCode).toBe(404);
  });

  it("rejects malformed descriptors and conflicting revisions or org-key epochs", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    for (const descriptor of [b64(304), b64(MAX_DESCRIPTOR_BYTES + 1), `${sealed()}=`, Buffer.alloc(305).toString("base64url"), 5]) {
      expect((await publish(a.token, orgId, 1, 1, descriptor as string)).json()).toEqual({ error: "bad-descriptor" });
    }
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect((await publish(a.token, orgId, revision as number)).statusCode).toBe(400);
    }
    expect((await publish(a.token, orgId, 1, 0)).statusCode).toBe(400);
    expect((await publish(a.token, orgId, 1, 2)).json()).toEqual({ error: "org-key-epoch", currentKeyId: 1 });
    expect((await publish(a.token, orgId)).statusCode).toBe(201);
    expect((await publish(a.token, orgId)).json()).toEqual({ error: "revision", currentRevision: 1 });
    expect((await publish(a.token, orgId, 3)).statusCode).toBe(409);
    expect((await publish(a.token, orgId, 2)).statusCode).toBe(200);
  });

  it("cannot publish before the org has a key", async () => {
    const a = await account();
    const orgId = await createOrg(a, "Keyless", false);
    expect((await publish(a.token, orgId, 1, 1)).json()).toEqual({ error: "org-key-epoch", currentKeyId: 0 });
    expect((await call(a.token, "GET", `/v1/orgs/${orgId}/fleet`)).json()).toEqual({ orgKeyId: 0, computers: [] });
  });

  it("rejects an oversized request before storing it", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    expect((await publish(a.token, orgId, 1, 1, b64(24 * 1024))).statusCode).toBe(413);
    expect(await fleet(a.token, orgId)).toEqual([]);
  });

  it("needs a sync plan to publish or heartbeat, but not to read or withdraw", async () => {
    const owner = await account();
    const member = await account();
    const orgId = await createOrg(owner);
    await addMember(owner, orgId, member);
    await publish(member.token, orgId);
    await db.query("update users set plan = 'free' where id = $1", [member.user]);
    expect((await publish(member.token, orgId, 2)).json()).toMatchObject({ error: "plan-required" });
    expect((await call(member.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(402);
    expect(await fleet(member.token, orgId)).toHaveLength(1);
    expect((await call(member.token, "DELETE", `/v1/orgs/${orgId}/fleet/self`)).statusCode).toBe(204);
    expect(await fleet(owner.token, orgId)).toEqual([]);
  });

  it("withdraws only oneself, needs a device token, and keeps the revision guard", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    const phone = await join(a);
    await publish(a.token, orgId);
    // The phone has nothing published, so withdrawing from it changes nothing.
    expect((await call(phone.token, "DELETE", `/v1/orgs/${orgId}/fleet/self`)).statusCode).toBe(204);
    expect(await fleet(a.token, orgId)).toHaveLength(1);
    expect((await call(await bareToken(a), "DELETE", `/v1/orgs/${orgId}/fleet/self`)).json()).toEqual({ error: "needs-device" });
    expect((await call(a.token, "DELETE", `/v1/orgs/${orgId}/fleet/self`)).statusCode).toBe(204);
    expect(await fleet(phone.token, orgId)).toEqual([]);
    expect((await publish(a.token, orgId, 2)).json()).toEqual({ error: "revision", currentRevision: 2 });
    expect((await call(a.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(409);
    expect((await publish(a.token, orgId, 3)).statusCode).toBe(200);
    expect(await fleet(phone.token, orgId)).toHaveLength(1);
  });

  it("hides a signed-out host and requires a freshly proven sign-in to republish", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    const phone = await join(a);
    await publish(a.token, orgId);
    expect((await call(a.token, "DELETE", "/v1/auth/session")).statusCode).toBe(204);
    expect(await fleet(phone.token, orgId)).toEqual([]);
    expect((await publish(a.token, orgId, 2)).statusCode).toBe(401);
  });

  it("hides computers whose account re-keyed until they prove the new epoch", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    const phone = await join(a);
    await publish(phone.token, orgId);
    expect((await call(a.token, "PUT", "/v1/sync/keyrings/2", {
      recoveryWrap: vectors.recovery.blob, proof: proof(2), wraps: [a, phone].map((d) => ({ deviceId: d.id, wrap: vectors.wrap.blob })),
    })).statusCode).toBe(201);
    expect((await call(phone.token, "GET", `/v1/orgs/${orgId}/fleet`)).statusCode).toBe(403);
    expect((await call(phone.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(403);
    // The device that made the new epoch holds it; the phone has not proven it yet.
    expect(await fleet(a.token, orgId)).toEqual([]);
    await call(phone.token, "POST", "/v1/sync/keyrings/2/proof", { proof: proof(2) });
    expect(await fleet(a.token, orgId)).toHaveLength(1);
    expect((await call(phone.token, "POST", `/v1/orgs/${orgId}/fleet/self/heartbeat`)).statusCode).toBe(200);
  });

  it("hides expired publisher tokens and missing wraps before presence expires", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    const phone = await join(a);
    await publish(a.token, orgId);
    await db.query("update api_tokens set expires_at = now() - interval '1 second' where device_id = $1", [a.id]);
    expect(await fleet(phone.token, orgId)).toEqual([]);
    await db.query("update api_tokens set expires_at = now() + interval '1 day' where device_id = $1", [a.id]);
    expect(await fleet(phone.token, orgId)).toHaveLength(1);
    await db.query("delete from sync_key_wraps where device_id = $1", [a.id]);
    expect(await fleet(phone.token, orgId)).toEqual([]);
  });

  it("keeps each org's fleet separate", async () => {
    const a = await account();
    const b = await account();
    const one = await createOrg(a, "One");
    const two = await createOrg(b, "Two");
    await publish(a.token, one);
    await publish(b.token, two);
    expect((await fleet(a.token, one)).map((c: { deviceId: string }) => c.deviceId)).toEqual([a.id]);
    expect((await fleet(b.token, two)).map((c: { deviceId: string }) => c.deviceId)).toEqual([b.id]);
    expect((await call(a.token, "GET", `/v1/orgs/${two}/fleet`)).statusCode).toBe(404);
    // One device may be in several orgs with independent revisions.
    const three = await createOrg(a, "Three");
    expect((await publish(a.token, three)).statusCode).toBe(201);
    expect((await publish(a.token, one, 2)).statusCode).toBe(200);
    expect((await publish(a.token, three)).statusCode).toBe(409);
    expect(await fleet(a.token, one)).toHaveLength(1);
    expect(await fleet(a.token, three)).toHaveLength(1);
    // Withdrawing from one org leaves the other.
    await call(a.token, "DELETE", `/v1/orgs/${one}/fleet/self`);
    expect(await fleet(a.token, one)).toEqual([]);
    expect(await fleet(a.token, three)).toHaveLength(1);
    // Joining a second org does not expose the first org's computers.
    await addMember(b, two, a);
    expect((await fleet(a.token, two)).map((c: { deviceId: string }) => c.deviceId)).toEqual([b.id]);
  });

  it("caps advertised computers per org", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    await db.query(
      `with d as (insert into sync_devices (user_id, public_key, label)
         select $1, decode('04' || lpad(to_hex(n), 128, '0'), 'hex'), 'fixture' from generate_series(1, $3::int) n returning id)
       insert into org_fleet_computers (org_id, device_id, user_id, org_key_id, revision, descriptor)
         select $2, id, $1, 1, 1, $4 from d`,
      [a.user, orgId, MAX_ORG_COMPUTERS, Buffer.from(sealed(), "base64url")],
    );
    expect((await publish(a.token, orgId)).json()).toEqual({ error: "fleet-full" });
  });
});

describe("organizations: cleanup", () => {
  it("removes a revoked device's computers", async () => {
    const a = await account();
    const orgId = await createOrg(a);
    const phone = await join(a);
    await publish(phone.token, orgId);
    expect((await call(a.token, "DELETE", `/v1/sync/devices/${phone.id}`)).statusCode).toBe(204);
    expect(await fleet(a.token, orgId)).toEqual([]);
    expect(await rows("select count(*)::int as n from org_fleet_computers where device_id = $1", [phone.id])).toBe(0);
    expect((await call(phone.token, "GET", `/v1/orgs/${orgId}/fleet`)).statusCode).toBe(401);
    expect(await rows("select count(*)::int as n from org_members where user_id = $1", [a.user])).toBe(1);
  });

  it("removes a user's computers with sync deletion but keeps the membership", async () => {
    const a = await account();
    const b = await account();
    const orgId = await createOrg(a);
    await addMember(a, orgId, b);
    await publish(a.token, orgId);
    await publish(b.token, orgId);
    expect((await call(a.token, "DELETE", "/v1/sync")).statusCode).toBe(204);
    expect(await rows("select count(*)::int as n from org_fleet_computers where user_id = $1", [a.user])).toBe(0);
    expect(await rows("select count(*)::int as n from org_fleet_computers where user_id = $1", [b.user])).toBe(1);
    expect(await rows("select count(*)::int as n from org_members where user_id = $1", [a.user])).toBe(1);
    expect((await call(a.token, "GET", `/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });

  it("deletes the orgs an account alone owns with the account, and only its share of the rest", async () => {
    const a = await account();
    const b = await account();
    const solo = await createOrg(a, "Solo");
    const shared = await createOrg(a, "Shared");
    await addMember(a, shared, b);
    await publish(a.token, shared);
    await publish(b.token, shared);
    const pending = await invite(a, shared, await account("pro", "gone@example.com"));
    const toA = await call(b.token, "POST", `/v1/orgs`, { name: "B owns" });
    await invite(b, toA.json().id, a);
    expect(pending).toBeTruthy();
    expect((await call(a.token, "DELETE", "/v1/account")).statusCode).toBe(204);
    expect(await rows("select count(*)::int as n from orgs where id = $1", [solo])).toBe(0);
    // `shared` had only a as owner, so it goes too; b's own org stays.
    expect(await rows("select count(*)::int as n from orgs where id = $1", [shared])).toBe(0);
    expect(await rows("select count(*)::int as n from org_fleet_computers")).toBe(0);
    expect(await rows("select count(*)::int as n from orgs where id = $1", [toA.json().id])).toBe(1);
    expect(await rows("select count(*)::int as n from org_invites where email = lower($1)", [a.email])).toBe(0);
    expect((await call(b.token, "GET", "/v1/orgs")).json().orgs.map((o: { name: string }) => o.name)).toEqual(["B owns"]);
  });

  it("keeps an org with another owner when one owner's account is deleted", async () => {
    const a = await account();
    const b = await account();
    const orgId = await createOrg(a);
    await addMember(a, orgId, b);
    await db.query("update org_members set role = 'owner' where user_id = $1", [b.user]);
    await publish(a.token, orgId);
    await publish(b.token, orgId);
    expect((await call(a.token, "DELETE", "/v1/account")).statusCode).toBe(204);
    expect(await rows("select count(*)::int as n from orgs where id = $1", [orgId])).toBe(1);
    expect(await rows("select count(*)::int as n from org_members where org_id = $1", [orgId])).toBe(1);
    expect(await fleet(b.token, orgId)).toHaveLength(1);
    expect((await call(b.token, "GET", `/v1/orgs/${orgId}`)).json().members).toHaveLength(1);
    expect(await rows("select count(*)::int as n from orgs where created_by is null")).toBe(1);
  });

  it("deletes an org with its members, invites and computers", async () => {
    const a = await account();
    const b = await account();
    const orgId = await createOrg(a);
    await addMember(a, orgId, b);
    await invite(a, orgId, await account());
    await publish(b.token, orgId);
    expect((await call(a.token, "DELETE", `/v1/orgs/${orgId}`)).statusCode).toBe(204);
    for (const table of ["org_members", "org_invites", "org_fleet_computers"]) {
      expect(await rows(`select count(*)::int as n from ${table}`)).toBe(0);
    }
  });
});

describe("organizations: limits", () => {
  it("rate limits org requests before token checks", async () => {
    const limited = buildServer({ db, allowedOrigins: [], orgsEnabled: true, syncRateLimit: { max: 1, windowMs: 60_000 } });
    try {
      expect((await limited.inject({ method: "GET", url: "/v1/orgs" })).statusCode).toBe(401);
      expect((await limited.inject({ method: "GET", url: "/v1/orgs" })).statusCode).toBe(429);
    } finally { await limited.close(); }
  });
});
