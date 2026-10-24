import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { FlyDriver, MemoryDriver } from "./fly.js";
import { DEFAULT_SCOPE, MACHINE_LIMIT, egressHosts, parseScope } from "./machines.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

let db: Db;
let driver: MemoryDriver;
beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  driver = new MemoryDriver();
});
afterEach(() => db.close());

const RELAY = "wss://relay.test";
const app = () => buildServer({ db, allowedOrigins: [], machines: { driver, relayUrl: RELAY, image: "ghcr.io/nekko-labs/nekko-agent@sha256:abc" } });
type App = ReturnType<typeof app>;

async function user(plan: "free" | "pro" | "team" = "pro") {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan) values ($1, $2) returning id", [`${randomBytes(4).toString("hex")}@example.com`, plan]);
  return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
}
const call = (a: App, token: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  a.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

describe("the scope: what the phone lets the cloud see", () => {
  it("is minimal by default and checked field by field", () => {
    expect(parseScope(undefined)).toEqual(DEFAULT_SCOPE);
    expect(parseScope({ repos: ["nekko-labs/nekko-agent", "nekko-labs/nekko-agent"], privacyShield: false })).toEqual({ repos: ["nekko-labs/nekko-agent"], privacyShield: false, memory: false, syncBack: true });
    expect(() => parseScope({ repos: ["../etc"] })).toThrow("owner/repo");
    expect(() => parseScope({ repos: "x" })).toThrow();
    expect(() => parseScope({ memory: "yes" })).toThrow("memory");
    expect(() => parseScope({ shell: true })).toThrow("unknown scope field shell");
    expect(() => parseScope({ repos: Array.from({ length: 21 }, (_, i) => `o/r${i}`) })).toThrow("at most 20");
    expect(egressHosts(DEFAULT_SCOPE, ["api.anthropic.com"])).toEqual(["api.anthropic.com"]);
    expect(egressHosts({ ...DEFAULT_SCOPE, repos: ["o/r"] })).toEqual(["api.github.com", "codeload.github.com", "github.com"]);
  });
});

describe("machines", () => {
  it("needs Pro or Team to make one, and hands the phone the pairing link once", async () => {
    const a = app();
    const free = await user("free");
    expect((await call(a, free.token, "POST", "/v1/machines", {})).statusCode).toBe(402);
    expect((await call(a, free.token, "GET", "/v1/machines")).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/v1/machines" })).statusCode).toBe(401);

    const pro = await user("pro");
    const made = await call(a, pro.token, "POST", "/v1/machines", { name: "Tokyo box", region: "nrt", scope: { repos: ["nekko-labs/nekko-agent"] } });
    expect(made.statusCode).toBe(201);
    const body = made.json();
    expect(body.machine.state).toBe("running");
    expect(body.machine.scope).toEqual({ ...DEFAULT_SCOPE, repos: ["nekko-labs/nekko-agent"] });
    expect(body.machine.egress).toContain("github.com");
    expect(body.pairingLink).toMatch(/^nekko-agent-pair:\?relay=wss%3A%2F%2Frelay\.test&room=[a-z0-9]{20}&key=[A-Za-z0-9_-]{32}&pair=[A-Z2-9]{8}$/);
    // The machine got the same room, key and code in its environment, and the scope.
    const [, spec] = [...driver.machines.values()].map((m) => [m.state, m.spec] as const)[0];
    expect(spec.env.NEKKO_ROOM).toBe(body.machine.room);
    expect(body.pairingLink).toContain(`key=${spec.env.NEKKO_PAIR_KEY}`);
    expect(spec.env.NEKKO_PAIR_CODE).toBe(body.pairingCode);
    expect(JSON.parse(spec.env.NEKKO_CLOUD_SCOPE)).toEqual(body.machine.scope);
    expect(spec.env.NEKKO_SANDBOX).toBe("workspace-jail");
    expect(spec.image).toContain("@sha256:");
    // Only the key's hash is stored: the list never shows it, and the row holds no key.
    const list = (await call(a, pro.token, "GET", "/v1/machines")).json();
    expect(list.machines).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(spec.env.NEKKO_PAIR_KEY);
    const { rows } = await db.query<{ key_hash: Uint8Array }>("select key_hash from cloud_machines");
    expect(Buffer.from(rows[0].key_hash).toString("base64url")).not.toBe(spec.env.NEKKO_PAIR_KEY);
  });

  it("refuses a bad region or scope, and caps machines per account", async () => {
    const a = app();
    const pro = await user("pro");
    expect((await call(a, pro.token, "POST", "/v1/machines", { region: "mars" })).statusCode).toBe(400);
    expect((await call(a, pro.token, "POST", "/v1/machines", { scope: { repos: ["bad repo"] } })).statusCode).toBe(400);
    for (let i = 0; i < MACHINE_LIMIT; i++) expect((await call(a, pro.token, "POST", "/v1/machines", {})).statusCode).toBe(201);
    expect((await call(a, pro.token, "POST", "/v1/machines", {})).statusCode).toBe(409);
  });

  it("stops, starts, rescopes and deletes a machine, metering its hours", async () => {
    const a = app();
    const pro = await user("pro");
    const other = await user("pro");
    const id = (await call(a, pro.token, "POST", "/v1/machines", {})).json().machine.id;
    expect((await call(a, other.token, "GET", `/v1/machines/${id}`)).statusCode).toBe(404);
    const stopped = (await call(a, pro.token, "POST", `/v1/machines/${id}/stop`)).json().machine;
    expect(stopped.state).toBe("stopped");
    expect([...driver.machines.values()][0].state).toBe("stopped");
    const rescoped = (await call(a, pro.token, "PUT", `/v1/machines/${id}/scope`, { privacyShield: false, repos: ["o/r"] })).json();
    expect(rescoped.machine.scope).toEqual({ repos: ["o/r"], privacyShield: false, memory: false, syncBack: true });
    expect(rescoped.appliesOn).toBe("next start");
    expect((await call(a, pro.token, "PUT", `/v1/machines/${id}/scope`, { repos: "x" })).statusCode).toBe(400);
    const started = (await call(a, pro.token, "POST", `/v1/machines/${id}/start`)).json().machine;
    expect(started.state).toBe("running");
    // A machine that stopped itself when idle reads as stopped on the next look.
    await driver.stop([...driver.machines.keys()][0]);
    expect((await call(a, pro.token, "GET", `/v1/machines/${id}`)).json().machine.state).toBe("stopped");
    expect((await call(a, pro.token, "DELETE", `/v1/machines/${id}`)).statusCode).toBe(204);
    expect((await call(a, pro.token, "GET", `/v1/machines/${id}`)).statusCode).toBe(404);
    expect((await call(a, pro.token, "GET", "/v1/machines")).json().machines).toHaveLength(0);
    expect([...driver.machines.values()][0].state).toBe("gone");
  });

  it("lets the relay admit only a live machine's access token", async () => {
    const a = app();
    const pro = await user("pro");
    const id = (await call(a, pro.token, "POST", "/v1/machines", {})).json().machine.id;
    const access = [...driver.machines.values()][0].spec.env.NEKKO_RELAY_ACCESS;
    const authorize = (token: string) => a.inject({ method: "POST", url: "/v1/relay/authorize", headers: { authorization: `Bearer ${token}` } });
    expect((await authorize(access)).json()).toEqual({ ok: true });
    expect((await authorize("nkm_" + "x".repeat(43))).statusCode).toBe(403);
    expect((await authorize("nk_notamachine")).statusCode).toBe(401);
    await call(a, pro.token, "DELETE", `/v1/machines/${id}`);
    expect((await authorize(access)).statusCode).toBe(403);
  });
});

describe("the Fly driver", () => {
  it("speaks the Machines API with the token, never in a URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "POST" && url.endsWith("/machines")) return new Response(JSON.stringify({ id: "m-1" }), { status: 200 });
      if (init.method === "GET") return new Response(JSON.stringify({ state: "started" }), { status: 200 });
      if (init.method === "DELETE") return new Response(null, { status: 404 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const fly = new FlyDriver({ token: "fo1_secret", app: "nekko-cloud-machines", api: "https://fly.test", fetch: fetchImpl });
    const { ref } = await fly.create({ name: "n", region: "nrt", image: "img", size: "small", env: { NEKKO_ROOM: "r" } });
    expect(ref).toBe("m-1");
    expect(calls[0].url).toBe("https://fly.test/v1/apps/nekko-cloud-machines/machines");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 4096 });
    expect(sent.config.services).toEqual([]);
    expect(sent.config.auto_destroy).toBe(false);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer fo1_secret");
    expect(calls.every((c) => !c.url.includes("fo1_secret"))).toBe(true);
    expect(await fly.state("m-1")).toBe("running");
    await expect(fly.destroy("m-1")).rejects.toThrow("404");
  });
});
