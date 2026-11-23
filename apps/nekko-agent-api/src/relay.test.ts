import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { accountChannelId, parseSigningKey, publicKeyText, signTicket, verifyTicket } from "./relay.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const { privateKey } = generateKeyPairSync("ed25519");
const publicKey = createPublicKey(privateKey);
let db: Db;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  app = buildServer({ db, allowedOrigins: [], relay: { signingKey: privateKey, url: "wss://relay.test" } });
});
afterEach(async () => { await app.close(); await db.close(); });

async function user(email: string, plan = "free") {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, $2, true) returning id", [email, plan]);
  return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
}
const call = (token: string | null, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
const switchRelay = async (staffToken: string, state: string) => {
  expect((await call(staffToken, "PUT", "/v1/staff/features/cloud-relay", { state })).statusCode).toBe(200);
};
const ROOM = "a1b2c3d4e5f60718";

describe("Nekko Cloud Relay tickets", () => {
  it("does not exist while the switch is off", async () => {
    const pro = await user("pro@example.com", "pro");
    expect((await call(pro.token, "POST", "/v1/relay/ticket", { scope: "agent", room: ROOM })).statusCode).toBe(404);
    expect((await call(pro.token, "GET", "/v1/relay")).statusCode).toBe(404);
  });

  it("is a Pro and Team perk once switched on, and asks Free to upgrade", async () => {
    const staff = await user("philip@nekkolabs.com");
    await switchRelay(staff.token, "on");
    const free = await user("free@example.com");
    const pro = await user("pro@example.com", "pro");
    const team = await user("team@example.com", "team");

    const denied = await call(free.token, "POST", "/v1/relay/ticket", { scope: "agent", room: ROOM });
    expect(denied.statusCode).toBe(402);
    expect(denied.json()).toEqual({ error: "plan-required", plan: "free", needs: ["pro", "team"] });
    expect((await call(free.token, "GET", "/v1/relay")).json()).toEqual({ url: "wss://relay.test", included: false, plan: "free", needs: ["pro", "team"] });

    for (const u of [pro, team]) {
      const r = await call(u.token, "POST", "/v1/relay/ticket", { scope: "agent", room: ROOM.toUpperCase() });
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const body = r.json();
      expect(body.url).toBe("wss://relay.test");
      expect(body.renewAfterSeconds).toBe(3 * 60 * 60);
      const p = verifyTicket(publicKey, body.ticket);
      expect(p).toMatchObject({ v: 1, scope: "agent", room: ROOM, acct: accountChannelId(u.id) });
      expect(p!.exp - p!.iat).toBe(6 * 60 * 60);
      expect(new Date(body.expiresAt).getTime()).toBe(p!.exp * 1000);
    }
  });

  it("lets team accounts try it on any plan while it is team-only, and nobody else", async () => {
    const staff = await user("philip@nekkolabs.com");
    await switchRelay(staff.token, "team");
    const pro = await user("pro@example.com", "pro");
    expect((await call(pro.token, "POST", "/v1/relay/ticket", { scope: "account" })).statusCode).toBe(404);
    const r = await call(staff.token, "POST", "/v1/relay/ticket", { scope: "account" });
    expect(r.statusCode).toBe(200);
    expect(verifyTicket(publicKey, r.json().ticket)).toMatchObject({ scope: "account", plan: "free" });
  });

  it("names no user: the account id is a hash, and the ticket carries no email", async () => {
    const staff = await user("philip@nekkolabs.com");
    await switchRelay(staff.token, "on");
    const pro = await user("someone@example.com", "pro");
    const ticket = (await call(pro.token, "POST", "/v1/relay/ticket", { scope: "account" })).json().ticket as string;
    const payload = Buffer.from(ticket.split(".")[1], "base64url").toString();
    expect(payload).not.toContain(pro.id);
    expect(payload).not.toContain("someone");
    expect(JSON.parse(payload).dev).toMatch(/^t:/);
  });

  it("refuses bad requests and anonymous callers", async () => {
    const staff = await user("philip@nekkolabs.com");
    await switchRelay(staff.token, "on");
    const pro = await user("pro@example.com", "pro");
    expect((await call(null, "POST", "/v1/relay/ticket", { scope: "agent", room: ROOM })).statusCode).toBe(401);
    for (const body of [{}, { scope: "client" }, { scope: "agent" }, { scope: "agent", room: "not hex!" }, { scope: "account", room: ROOM }, { scope: "agent", room: ROOM, extra: 1 }]) {
      expect((await call(pro.token, "POST", "/v1/relay/ticket", body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("is absent without a signing key, whatever the switch says", async () => {
    await app.close();
    app = buildServer({ db, allowedOrigins: [] });
    const staff = await user("philip@nekkolabs.com");
    const r = await call(staff.token, "GET", "/v1/staff/features");
    expect(r.json().available).not.toContain("cloud-relay");
    expect((await call(staff.token, "POST", "/v1/relay/ticket", { scope: "account" })).statusCode).toBe(404);
  });
});

describe("ticket format", () => {
  it("rejects a forged, altered or expired ticket", () => {
    const now = Math.floor(Date.now() / 1000);
    const good = signTicket(privateKey, { v: 1, scope: "agent", acct: "a", dev: "d", room: ROOM, plan: "pro", iat: now, exp: now + 60 });
    expect(verifyTicket(publicKey, good)).not.toBeNull();
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(verifyTicket(publicKey, signTicket(other, { v: 1, scope: "agent", acct: "a", dev: "d", room: ROOM, plan: "pro", iat: now, exp: now + 60 }))).toBeNull();
    const [p, body, sig] = good.split(".");
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), room: "ffffffff" })).toString("base64url");
    expect(verifyTicket(publicKey, `${p}.${altered}.${sig}`)).toBeNull();
    expect(verifyTicket(publicKey, good, now + 61)).toBeNull();
    expect(verifyTicket(publicKey, "nkr2" + good.slice(4))).toBeNull();
  });

  it("reads the signing key as a PEM or a raw seed, and prints the relay's public key", () => {
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(publicKeyText(parseSigningKey(pem))).toBe(publicKeyText(privateKey));
    const seed = Buffer.alloc(32, 7);
    const fromSeed = parseSigningKey(seed.toString("base64url"));
    expect(publicKeyText(fromSeed)).toBe(publicKeyText(parseSigningKey(seed.toString("base64"))));
    expect(() => parseSigningKey("short")).toThrow();
  });

  it("matches the vector the relay checks (relay-ticket-vector.json)", () => {
    const vector = JSON.parse(readFileSync(new URL("./relay-ticket-vector.json", import.meta.url), "utf8"));
    const key = parseSigningKey(vector.seed);
    expect(publicKeyText(key)).toBe(vector.publicKey);
    expect(signTicket(key, vector.payload)).toBe(vector.ticket);
  });
});
