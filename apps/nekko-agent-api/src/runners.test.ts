import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { HOLD_MS, OIDC_ISSUER, RUNNER_LEASE_MS, RunnerPresenceStore, githubJwks, parsePresence, verifyOidc } from "./runners.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1" };
const jwks = async (kid: string) => (kid === "k1" ? jwk : null);
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
let clock = Date.parse("2026-11-26T12:00:00Z");
const now = () => clock;

/** A GitHub Actions ID token, signed with the test key unless `key` says otherwise. */
function oidc(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const h = b64({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const p = b64({ iss: OIDC_ISSUER, aud: "nekko-cloud", exp: clock / 1000 + 300, repository: "Nekko-Labs/nekko-agent", repository_owner: "nekko-labs", event_name: "push", ref: "refs/heads/main", ...claims });
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

describe("GitHub OIDC", () => {
  it("accepts GitHub's token for us and lower-cases the repository", async () => {
    expect(await verifyOidc(oidc(), jwks, clock)).toMatchObject({ repository: "nekko-labs/nekko-agent", eventName: "push" });
    expect(await verifyOidc(oidc({ aud: ["x", "nekko-cloud"] }), jwks, clock)).not.toBeNull();
  });

  it("refuses a wrong issuer, audience, expiry, key, algorithm, signature or repository", async () => {
    const bad = [
      oidc({ iss: "https://evil.example" }),
      oidc({ aud: "someone-else" }),
      oidc({ exp: clock / 1000 - 1 }),
      oidc({ nbf: clock / 1000 + 600 }),
      oidc({}, { kid: "k2" }),
      oidc({}, { alg: "HS256" }),
      oidc({ repository: "../../etc" }),
      oidc().slice(0, -4) + "AAAA",
      "not.a.jwt",
      "",
    ];
    for (const t of bad) expect(await verifyOidc(t, jwks, clock), t.slice(0, 40)).toBeNull();
    // A forged payload under a genuine header and signature.
    const [h, , s] = oidc().split(".");
    expect(await verifyOidc(`${h}.${b64({ iss: OIDC_ISSUER, aud: "nekko-cloud", exp: clock / 1000 + 300, repository: "evil/repo" })}.${s}`, jwks, clock)).toBeNull();
  });

  it("caches GitHub's keys and refetches an unknown kid at most once a minute", async () => {
    let fetches = 0;
    const fake = (async () => { fetches++; return new Response(JSON.stringify({ keys: [jwk] })); }) as typeof fetch;
    const read = githubJwks(fake, now);
    expect(await read("k1")).toEqual(jwk);
    expect(await read("k1")).toEqual(jwk);
    expect(await read("nope")).toBeNull();
    expect(fetches).toBe(1);
    clock += 61_000;
    expect(await read("nope")).toBeNull();
    expect(fetches).toBe(2);
  });
});

describe("presence and picking", () => {
  const mac = (free = 1, repos = ["nekko-labs/nekko-agent"]) => [{ label: "nekko-cloud-mac", repos, free: { macos: free, linux: 0 } }];

  it("checks the body", () => {
    expect(parsePresence({ runners: [{ label: "nekko-cloud-mac", repos: ["Nekko-Labs/Nekko-Agent"], free: { macos: 1, linux: 2 } }] })).toEqual([
      { label: "nekko-cloud-mac", repos: ["nekko-labs/nekko-agent"], free: { macos: 1, linux: 2 } },
    ]);
    for (const bad of [null, {}, { runners: "x" }, { runners: [{ label: "a b", repos: [], free: { macos: 0, linux: 0 } }] }, { runners: [{ label: "a", repos: ["nope"], free: { macos: 0, linux: 0 } }] }, { runners: [{ label: "a", repos: [], free: { macos: -1, linux: 0 } }] }, { runners: Array(9).fill({ label: "a", repos: [], free: { macos: 0, linux: 0 } }) }]) {
      expect(parsePresence(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("picks a live Mac that serves the repository, holds its VM, and lets the lease lapse", () => {
    const s = new RunnerPresenceStore(now);
    s.set("t1", "u1", mac(1));
    expect(s.pick("someone/else", "nekko-cloud-mac", "macos")).toBeNull();
    expect(s.pick("nekko-labs/nekko-agent", "other-label", "macos")).toBeNull();
    expect(s.pick("nekko-labs/nekko-agent", "nekko-cloud-mac", "linux")).toBeNull();
    expect(s.pick("nekko-labs/nekko-agent", "nekko-cloud-mac", "macos")).toEqual(["self-hosted", "nekko-cloud-mac"]);
    expect(s.pick("nekko-labs/nekko-agent", "nekko-cloud-mac", "macos"), "the one VM is held").toBeNull();
    clock += HOLD_MS;
    s.set("t1", "u1", mac(1));
    expect(s.pick("nekko-labs/nekko-agent", "nekko-cloud-mac", "macos"), "the hold ended").not.toBeNull();
    clock += RUNNER_LEASE_MS + HOLD_MS;
    expect(s.pick("nekko-labs/nekko-agent", "nekko-cloud-mac", "macos"), "no beat, no Mac").toBeNull();
  });

  it("names the Linux label for a Linux job and prefers the Mac with more free", () => {
    const s = new RunnerPresenceStore(now);
    s.set("t1", "u1", [{ label: "m", repos: ["a/b"], free: { macos: 1, linux: 1 } }]);
    s.set("t2", "u2", [{ label: "m", repos: ["a/b"], free: { macos: 0, linux: 3 } }]);
    expect(s.pick("a/b", "m", "linux")).toEqual(["self-hosted", "m-linux"]);
    expect(s.pick("a/b", "m", "linux")).toEqual(["self-hosted", "m-linux"]);
    expect(s.pick("a/b", "m", "linux")).toEqual(["self-hosted", "m-linux"]);
    expect(s.pick("a/b", "m", "linux")).toEqual(["self-hosted", "m-linux"]);
    expect(s.pick("a/b", "m", "linux"), "four VMs, four holds").toBeNull();
  });
});

describe("routes", () => {
  let db: Db;
  let app: ReturnType<typeof buildServer>;
  beforeEach(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, undefined, { lock: false });
    app = buildServer({ db, allowedOrigins: [], runners: { jwks, now } });
  });
  afterEach(async () => { await app.close(); await db.close(); });

  async function user(email: string, plan = "free") {
    const { rows } = await db.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, $2, true) returning id", [email, plan]);
    return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
  }
  const call = (token: string | null, method: "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  const presence = { runners: [{ label: "nekko-cloud-mac", repos: ["nekko-labs/nekko-agent"], free: { macos: 1, linux: 0 } }] };
  const pick = (token = oidc()) => call(token, "POST", "/v1/runners/pick", { label: "nekko-cloud-mac" });

  it("is off until a staff account switches ci-fleet on, then needs a paid plan to publish", async () => {
    const staff = await user("philip@nekkolabs.com", "pro");
    const free = await user("free@example.com");
    expect((await call(staff.token, "PUT", "/v1/runners/presence", presence)).statusCode).toBe(404);
    expect((await call(staff.token, "PUT", "/v1/staff/features/ci-fleet", { state: "on" })).statusCode).toBe(200);
    expect((await call(null, "PUT", "/v1/runners/presence", presence)).statusCode).toBe(401);
    expect((await call(free.token, "PUT", "/v1/runners/presence", presence)).statusCode).toBe(402);
    expect((await call(staff.token, "PUT", "/v1/runners/presence", { runners: [{ label: "x" }] })).statusCode).toBe(400);
    const ok = await call(staff.token, "PUT", "/v1/runners/presence", presence);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ leaseSeconds: 90 });
  });

  it("answers a picker job from presence, and hosted once the Mac withdraws", async () => {
    const staff = await user("philip@nekkolabs.com", "pro");
    await call(staff.token, "PUT", "/v1/staff/features/ci-fleet", { state: "on" });
    expect((await pick()).json()).toEqual({ runsOn: null });
    await call(staff.token, "PUT", "/v1/runners/presence", presence);
    expect((await pick()).json()).toEqual({ runsOn: ["self-hosted", "nekko-cloud-mac"] });
    expect((await pick()).json(), "held").toEqual({ runsOn: null });
    expect((await call(staff.token, "DELETE", "/v1/runners/presence")).statusCode).toBe(204);
    clock += HOLD_MS;
    expect((await pick()).json()).toEqual({ runsOn: null });
  });

  it("refuses a picker without a valid GitHub token, or with a bad label", async () => {
    expect((await pick("nope")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/runners/pick", payload: { label: "x" } })).statusCode).toBe(401);
    expect((await call(oidc(), "POST", "/v1/runners/pick", { label: "has space" })).statusCode).toBe(400);
  });
});
