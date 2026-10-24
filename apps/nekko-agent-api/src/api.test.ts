import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { parseSignup } from "./signups.js";
import { pgliteDb } from "./test-db.js";

const ORIGIN = "https://nekkoagent.com";
let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = new PGlite();
  db = pgliteDb(pg);
  await migrate(db, undefined, { lock: false });
});
afterEach(() => db.close());

function server(rateLimit?: { max: number; windowMs: number }) {
  return buildServer({ db, allowedOrigins: [ORIGIN], rateLimit });
}

function post(app: ReturnType<typeof server>, payload: unknown, origin = ORIGIN) {
  return app.inject({ method: "POST", url: "/v1/signups", headers: { origin }, payload: payload as object });
}

describe("migrations", () => {
  it("creates every table and records itself once", async () => {
    expect(await migrate(db, undefined, { lock: false })).toEqual([]);
    const { rows } = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
      [],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "api_tokens", "donations", "feedback", "schema_migrations", "signups", "sync_devices", "sync_key_wraps", "sync_keyrings", "sync_objects", "sync_usage", "users",
    ]);
  });

  it("treats emails case-insensitively in users", async () => {
    await db.query("insert into users (email) values ($1)", ["Ada@Example.com"]);
    await expect(db.query("insert into users (email) values ($1)", ["ada@example.com"])).rejects.toThrow();
  });
});

describe("parseSignup", () => {
  it("rejects a bad email and an unknown list", () => {
    expect(parseSignup({ email: "nope" }).ok).toBe(false);
    expect(parseSignup({ email: "a@b.co", list: "Bad List" }).ok).toBe(false);
  });

  it("keeps only a path for source and only utm_* keys", () => {
    const parsed = parseSignup({
      email: " a@b.co ",
      name: "  Ada   Lovelace ",
      source: "/beta?ref=secret#x",
      utm: { utm_source: "hn", gclid: "drop-me" },
      extra: "ignored",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { email: "a@b.co", name: "Ada Lovelace", list: "beta", source: "/beta", utm: { utm_source: "hn" } },
    });
    expect(parseSignup({ email: "a@b.co", source: "https://evil.example/x" })).toMatchObject({
      value: { source: null },
    });
  });
});

describe("POST /v1/signups", () => {
  it("stores a signup on the beta list", async () => {
    const res = await post(server(), { email: "ada@example.com", name: "Ada", source: "/" });
    expect(res.statusCode).toBe(202);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const { rows } = await db.query("select email, name, list, status, source from signups", []);
    expect(rows).toEqual([{ email: "ada@example.com", name: "Ada", list: "beta", status: "pending", source: "/" }]);
  });

  it("answers a repeat signup the same way and keeps one row", async () => {
    const app = server();
    await post(app, { email: "ada@example.com" });
    const again = await post(app, { email: "ADA@example.com", name: "Ada" });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ ok: true });
    const { rows } = await db.query("select email, name from signups", []);
    expect(rows).toEqual([{ email: "ada@example.com", name: "Ada" }]);
  });

  it("puts an unsubscribed address back to pending, but leaves invited alone", async () => {
    const app = server();
    await post(app, { email: "u@example.com" });
    await post(app, { email: "i@example.com" });
    await db.query("update signups set status = $1 where email = $2", ["unsubscribed", "u@example.com"]);
    await db.query("update signups set status = $1 where email = $2", ["invited", "i@example.com"]);
    await post(app, { email: "u@example.com" });
    await post(app, { email: "i@example.com" });
    const { rows } = await db.query("select email, status from signups order by email", []);
    expect(rows).toEqual([
      { email: "i@example.com", status: "invited" },
      { email: "u@example.com", status: "pending" },
    ]);
  });

  it("refuses other origins, bad input, and drops honeypot hits", async () => {
    const app = server();
    expect((await post(app, { email: "a@b.co" }, "https://evil.example")).statusCode).toBe(403);
    expect((await post(app, { email: "nope" })).statusCode).toBe(400);
    expect((await post(app, { email: "bot@b.co", website: "spam" })).statusCode).toBe(202);
    const { rows } = await db.query("select count(*)::int as n from signups", []);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("answers the CORS preflight only for allowed origins", async () => {
    const app = server();
    const ok = await app.inject({ method: "OPTIONS", url: "/v1/signups", headers: { origin: ORIGIN } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-headers"]).toBe("content-type");
    const no = await app.inject({ method: "OPTIONS", url: "/v1/signups", headers: { origin: "https://evil.example" } });
    expect(no.statusCode).toBe(403);
  });

  it("rate-limits per IP", async () => {
    const app = server({ max: 2, windowMs: 60_000 });
    expect((await post(app, { email: "a1@b.co" })).statusCode).toBe(202);
    expect((await post(app, { email: "a2@b.co" })).statusCode).toBe(202);
    expect((await post(app, { email: "a3@b.co" })).statusCode).toBe(429);
  });
});
