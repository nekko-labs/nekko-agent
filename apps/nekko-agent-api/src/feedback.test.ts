import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { MAX_FEEDBACK_CHARS, parseFeedback } from "./feedback.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

let db: Db;

beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
});
afterEach(() => db.close());

function send(app: ReturnType<typeof buildServer>, payload: unknown) {
  return app.inject({ method: "POST", url: "/v1/feedback", payload: payload as object });
}

const APP = { app: "ios", version: "1.4.0", os: "iOS", osVersion: "18.1", arch: "arm64" };

describe("parseFeedback", () => {
  it("trims the note and needs one", () => {
    expect(parseFeedback({ message: "  the cat is slow  " })).toEqual({ ok: true, value: { message: "the cat is slow", appInfo: null } });
    expect(parseFeedback({ message: "   " }).ok).toBe(false);
    expect(parseFeedback({}).ok).toBe(false);
    expect(parseFeedback({ message: 42 }).ok).toBe(false);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(parseFeedback({ message: "🐈".repeat(MAX_FEEDBACK_CHARS) }).ok).toBe(true);
    expect(parseFeedback({ message: "a".repeat(MAX_FEEDBACK_CHARS + 1) }).ok).toBe(false);
  });

  it("keeps only the known app info fields", () => {
    const parsed = parseFeedback({ message: "hi", app: { ...APP, deviceName: "Ada's iPhone", locale: "ja-JP" } });
    expect(parsed).toEqual({ ok: true, value: { message: "hi", appInfo: APP } });
    expect(parseFeedback({ message: "hi", app: { app: "web", version: "1.0.0", os: "Linux" } })).toEqual({
      ok: true,
      value: { message: "hi", appInfo: { app: "web", version: "1.0.0", os: "Linux" } },
    });
  });

  it("rejects app info it can't vouch for", () => {
    for (const app of [
      { ...APP, app: "watch" },
      { ...APP, version: "" },
      { ...APP, os: undefined },
      { ...APP, osVersion: "18.1\nfoo" },
      { ...APP, arch: "x".repeat(17) },
      { ...APP, version: "<script>" },
      [APP],
      "ios",
    ]) expect(parseFeedback({ message: "hi", app }).ok, JSON.stringify(app)).toBe(false);
  });
});

describe("POST /v1/feedback", () => {
  it("stores the note and nothing about the sender", async () => {
    const app = buildServer({ db, allowedOrigins: [] });
    const res = await send(app, { message: "Love it", app: APP });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    await send(app, { message: "No info" });
    const { rows } = await db.query<Record<string, unknown>>("select * from feedback order by message", []);
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([["app_info", "id", "message", "received_on"], ["app_info", "id", "message", "received_on"]]);
    expect(rows.map((r) => [r.message, r.app_info])).toEqual([["Love it", APP], ["No info", null]]);
  });

  it("answers 400 for a bad note", async () => {
    const res = await send(buildServer({ db, allowedOrigins: [] }), { message: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad-feedback" });
  });

  it("rate-limits per IP", async () => {
    const app = buildServer({ db, allowedOrigins: [], feedbackRateLimit: { max: 2, windowMs: 60_000 } });
    expect((await send(app, { message: "1" })).statusCode).toBe(202);
    expect((await send(app, { message: "2" })).statusCode).toBe(202);
    const res = await send(app, { message: "3" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate-limited" });
  });
});
