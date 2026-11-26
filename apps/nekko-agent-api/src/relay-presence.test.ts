import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { LEASE_MS, Presence } from "./presence.js";
import { accountChannelId } from "./relay.js";
import { RELAY_PRESENCE_TTL_MS, RelayPresence } from "./relay-presence.js";
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
let relayNow = 0;
let fetches: { url: URL; auth: string | null }[];
let relayAnswer: (url: URL) => Response | Promise<Response>;
const relayFetch = (async (input: URL | string, init?: RequestInit) => {
  const url = new URL(String(input));
  fetches.push({ url, auth: new Headers(init?.headers).get("authorization") });
  return relayAnswer(url);
}) as unknown as typeof fetch;
const recording = (): Db => {
  const rec = (db: Db): Db => ({
    query: (t, p) => { log.push(t); return db.query(t, p); },
    transaction: (fn) => db.transaction((tx) => fn(rec(tx))),
    close: () => db.close(),
  });
  return rec(base);
};
const startServer = (relay = true) => buildServer({
  db: recording(), allowedOrigins: [], fleetEnabled: true, orgsEnabled: true, presence: new Presence(() => Date.now() + skew),
  relayPresence: relay ? new RelayPresence({ url: "http://relay.internal:8080", secret: "s3cret", fetch: relayFetch, now: () => relayNow }) : null,
});
const onlineAt = (map: Record<string, string[]>) => (url: URL) => {
  const online: Record<string, string[]> = {};
  for (const h of url.searchParams.getAll("acct")) if (map[h]?.length) online[h] = map[h];
  return Response.json({ online });
};
beforeEach(async () => {
  base = pgliteDb(new PGlite());
  await migrate(base, undefined, { lock: false });
  log = [];
  skew = 0;
  relayNow = 1_000_000;
  fetches = [];
  relayAnswer = onlineAt({});
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


describe("online from the relay", () => {
  async function expired() {
    const owner = await account();
    const member = await account();
    const org = await orgWith(owner, member);
    await publish(owner, org);
    skew += LEASE_MS + 1_000;
    return { owner, member, org };
  }

  it("counts a computer online when the relay says so, asking for the members' account hashes with the secret", async () => {
    const { owner, member, org } = await expired();
    expect((await seen(member, org))[0].online).toBe(false);
    relayAnswer = onlineAt({ [accountChannelId(owner.user)]: [owner.id] });
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    const list = await seen(member, org);
    expect(list[0]).toMatchObject({ deviceId: owner.id, online: true });
    expect(Date.parse(list[0].expiresAt) - Date.parse(list[0].seenAt)).toBe(LEASE_MS);
    const last = fetches.at(-1)!;
    expect(last.url.pathname).toBe("/presence");
    expect(last.url.searchParams.getAll("acct")).toEqual([accountChannelId(owner.user)]);
    expect(last.auth).toBe("Bearer s3cret");
    // The account's own fleet too.
    const mine = await account();
    await call(mine.token, "PUT", "/v1/fleet/self", { keyId: 1, revision: 1, descriptor: sealed() });
    skew += LEASE_MS + 1_000;
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    expect(((await call(mine.token, "GET", "/v1/fleet")).json().computers)[0].online).toBe(false);
    relayAnswer = onlineAt({ [accountChannelId(mine.user)]: [mine.id] });
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    expect(((await call(mine.token, "GET", "/v1/fleet")).json().computers)[0].online).toBe(true);
  });

  it("treats an account missing from the answer, and another device, as offline", async () => {
    const { owner, member, org } = await expired();
    relayAnswer = onlineAt({ [accountChannelId(owner.user)]: [randomBytes(16).toString("hex")] });
    expect((await seen(member, org))[0].online).toBe(false);
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    relayAnswer = onlineAt({});
    expect((await seen(member, org))[0].online).toBe(false);
  });

  it("asks the relay at most once per few seconds", async () => {
    const { member, org } = await expired();
    fetches = [];
    await seen(member, org);
    await seen(member, org);
    await seen(member, org);
    expect(fetches).toHaveLength(1);
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    await seen(member, org);
    expect(fetches).toHaveLength(2);
  });

  it("fails open to the lease when the relay errors, times out or answers nonsense, and remembers that briefly", async () => {
    const owner = await account();
    const org = await orgWith(owner);
    await publish(owner, org);
    await beat(owner, org);
    for (const answer of [() => new Response("no", { status: 500 }), () => new Response("not json", { status: 200 }), () => Response.json({ nope: 1 }), () => { throw new Error("down"); }]) {
      relayNow += RELAY_PRESENCE_TTL_MS + 1;
      relayAnswer = answer;
      fetches = [];
      const res = await call(owner.token, "GET", `/v1/orgs/${org}/fleet`);
      expect(res.statusCode).toBe(200);
      // The live lease still says online; nothing was lost.
      expect(res.json().computers[0].online).toBe(true);
      await seen(owner, org);
      expect(fetches).toHaveLength(1);
    }
    skew += LEASE_MS + 1_000;
    relayNow += RELAY_PRESENCE_TTL_MS + 1;
    expect((await seen(owner, org))[0].online).toBe(false);
  });

  it("is today's behaviour when unset: no request, the lease alone", async () => {
    await app.close();
    app = startServer(false);
    const owner = await account();
    const org = await orgWith(owner);
    await publish(owner, org);
    skew += LEASE_MS + 1_000;
    relayAnswer = onlineAt({ [accountChannelId(owner.user)]: [owner.id] });
    expect((await seen(owner, org))[0].online).toBe(false);
    expect(fetches).toEqual([]);
  });

  it("is configured from the environment, refusing a public plain-http URL and a missing secret", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(RelayPresence.fromEnv({}, warn)).toBeNull();
    expect(RelayPresence.fromEnv({ NEKKO_RELAY_PRESENCE_URL: "https://relay.example.com" }, warn)).toBeNull();
    expect(RelayPresence.fromEnv({ NEKKO_RELAY_PRESENCE_URL: "http://relay.example.com", NEKKO_RELAY_PRESENCE_SECRET: "x" }, warn)).toBeNull();
    expect(RelayPresence.fromEnv({ NEKKO_RELAY_PRESENCE_URL: "https://relay.example.com", NEKKO_RELAY_PRESENCE_SECRET: "x" }, warn)).toBeInstanceOf(RelayPresence);
    expect(RelayPresence.fromEnv({ NEKKO_RELAY_PRESENCE_URL: "http://nekko-relay.internal:8080/presence", NEKKO_RELAY_PRESENCE_SECRET: "x" }, warn)).toBeInstanceOf(RelayPresence);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("x");
  });
});
