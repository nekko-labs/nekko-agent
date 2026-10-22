import { PGlite } from "@electric-sql/pglite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { supabaseVerifier } from "./supabase.js";
import { pgliteDb } from "./test-db.js";

const URL_ = "https://proj.supabase.co";
const ISSUER = `${URL_}/auth/v1`;
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] };
});

let db: Db;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
});
afterEach(() => db.close());

function app(signIn = true) {
  return buildServer({
    db,
    allowedOrigins: [],
    signIn: signIn ? { supabaseUrl: URL_, supabaseAnonKey: "anon-public", verify: supabaseVerifier({ url: URL_, jwks }) } : undefined,
  });
}

interface Claims {
  sub?: string;
  email?: string;
  role?: string;
  is_anonymous?: boolean;
  iss?: string;
  aud?: string;
  exp?: string | number;
  key?: CryptoKey;
}

function jwt(c: Claims = {}) {
  const { key = privateKey, iss = ISSUER, aud = "authenticated", exp = "1h", ...rest } = c;
  const payload = { sub: "auth-user-1", email: "ada@example.com", role: "authenticated", is_anonymous: false, ...rest };
  return new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
}

const signIn = async (a: ReturnType<typeof app>, claims?: Claims, label = "MacBook") =>
  a.inject({ method: "POST", url: "/v1/auth/session", payload: { accessToken: await jwt(claims), label } });

describe("sign-in with Supabase", () => {
  it("serves the public config, or 503 when sign-in is off", async () => {
    expect((await app().inject({ method: "GET", url: "/v1/auth/config" })).json()).toEqual({ supabaseUrl: URL_, supabaseAnonKey: "anon-public" });
    expect((await app(false).inject({ method: "GET", url: "/v1/auth/config" })).statusCode).toBe(503);
    expect((await signIn(app(false))).statusCode).toBe(503);
  });

  it("creates a free account on first sign-in and issues a device token that sync accepts", async () => {
    const a = app();
    const res = await signIn(a);
    expect(res.statusCode).toBe(201);
    const { token, account } = res.json();
    expect(token).toMatch(/^nk_[A-Za-z0-9_-]{43}$/);
    expect(account).toMatchObject({ email: "ada@example.com", plan: "free", canSync: false });
    const me = await a.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ account: { id: account.id, plan: "free" }, device: null });
    expect((await a.inject({ method: "GET", url: "/v1/sync/state", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    const { rows } = await db.query<{ label: string; expires: boolean }>("select label, expires_at > now() + interval '179 days' as expires from api_tokens", []);
    expect(rows).toEqual([{ label: "MacBook", expires: true }]);
  });

  it("finds the same account again by subject, and follows an email change", async () => {
    const a = app();
    const first = (await signIn(a)).json().account.id;
    expect((await signIn(a)).json().account.id).toBe(first);
    const moved = (await signIn(a, { email: "ada@new.example" })).json().account;
    expect(moved).toMatchObject({ id: first, email: "ada@new.example" });
    expect((await db.query("select count(*)::int as n from users", [])).rows).toEqual([{ n: 1 }]);
  });

  it("links a beta signup's existing user and plan by email, and marks the signup joined", async () => {
    const a = app();
    await db.query("insert into users (email, plan) values ('ADA@example.com', 'pro')", []);
    await db.query("insert into signups (email) values ('ada@example.com')", []);
    const { account } = (await signIn(a)).json();
    expect(account).toMatchObject({ plan: "pro", canSync: true });
    const { rows } = await db.query<{ status: string; linked: boolean }>("select status, user_id is not null as linked from signups", []);
    expect(rows).toEqual([{ status: "joined", linked: true }]);
  });

  it("refuses an email another sign-in already owns", async () => {
    const a = app();
    await signIn(a);
    const res = await signIn(a, { sub: "auth-user-2" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("account-conflict");
  });

  it("refuses tokens that don't verify or aren't a real user", async () => {
    const a = app();
    for (const bad of [
      { key: otherKey },
      { iss: "https://evil.supabase.co/auth/v1" },
      { aud: "anon" },
      { exp: Math.floor(Date.now() / 1000) - 120 },
      { is_anonymous: true },
      { role: "anon" },
      { email: "" },
    ] as Claims[]) {
      const res = await signIn(a, bad);
      expect(res.statusCode, JSON.stringify(Object.keys(bad))).toBe(401);
      expect(res.json().error).toBe("invalid-session");
    }
    expect((await a.inject({ method: "POST", url: "/v1/auth/session", payload: { accessToken: "not.a.jwt" } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/v1/auth/session", payload: {} })).statusCode).toBe(400);
    expect((await db.query("select count(*)::int as n from users", [])).rows).toEqual([{ n: 0 }]);
  });

  it("verifies legacy HS256 projects with the JWT secret", async () => {
    const secret = "legacy-project-jwt-secret-at-least-32-chars";
    const verify = supabaseVerifier({ url: URL_, jwtSecret: secret });
    const token = await new SignJWT({ sub: "u", email: "a@b.co", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    expect(await verify(token)).toEqual({ subject: "u", email: "a@b.co" });
    await expect(verify(await jwt())).rejects.toThrow();
  });

  it("limits sign-ins tighter than account reads", async () => {
    const a = buildServer({
      db, allowedOrigins: [], authRateLimit: { max: 2, windowMs: 60_000 },
      signIn: { supabaseUrl: URL_, supabaseAnonKey: "anon-public", verify: supabaseVerifier({ url: URL_, jwks }) },
    });
    const token = (await signIn(a)).json().token;
    expect((await signIn(a)).statusCode).toBe(201);
    expect((await signIn(a)).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await a.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    }
  });

  it("signs out one device, and refuses expired tokens", async () => {
    const a = app();
    const t1 = (await signIn(a)).json().token;
    const t2 = (await signIn(a, {}, "iPhone")).json().token;
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    expect((await a.inject({ method: "DELETE", url: "/v1/auth/session", headers: h(t1) })).statusCode).toBe(204);
    expect((await a.inject({ method: "GET", url: "/v1/auth/me", headers: h(t1) })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/auth/me", headers: h(t2) })).statusCode).toBe(200);
    await db.query("update api_tokens set expires_at = now() - interval '1 minute'", []);
    expect((await a.inject({ method: "GET", url: "/v1/auth/me", headers: h(t2) })).statusCode).toBe(401);
  });
});
