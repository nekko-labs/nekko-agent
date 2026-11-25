import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import type { Db } from "./db.js";
import { BusyError, budgetForMachine, IDLE_RESERVE_BYTES, MemoryGate, memoryReport, MIN_BUDGET_BYTES, PAGE_FACTOR } from "./memory-gate.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const MB = 1024 * 1024;
const tick = () => new Promise((r) => setImmediate(r));

describe("MemoryGate", () => {
  it("admits while there is room and queues the rest in order", async () => {
    const gate = new MemoryGate({ budgetBytes: 10 });
    const a = await gate.acquire(6);
    const order: string[] = [];
    const b = gate.acquire(6).then((r) => (order.push("b"), r));
    // Small enough to fit now, but it waits behind b: nobody jumps the queue.
    const c = gate.acquire(1).then((r) => (order.push("c"), r));
    await tick();
    expect(order).toEqual([]);
    expect(gate.stats).toEqual({ inFlightBytes: 6, running: 1, queued: 2 });
    a();
    const rb = await b;
    const rc = await c;
    expect(order).toEqual(["b", "c"]);
    expect(gate.stats.inFlightBytes).toBe(7);
    rb();
    rc();
    expect(gate.stats).toEqual({ inFlightBytes: 0, running: 0, queued: 0 });
  });

  it("runs a request bigger than the whole budget alone", async () => {
    const gate = new MemoryGate({ budgetBytes: 10 });
    const small = await gate.acquire(2);
    let admitted = false;
    const big = gate.acquire(50).then((r) => ((admitted = true), r));
    await tick();
    expect(admitted).toBe(false);
    small();
    (await big)();
    expect(admitted).toBe(true);
    // And alone means alone: with nothing in flight it goes straight in.
    (await gate.acquire(50))();
  });

  it("answers busy after the wait limit, and when the queue is full", async () => {
    const gate = new MemoryGate({ budgetBytes: 10, maxWaitMs: 20, maxQueued: 1 });
    const hold = await gate.acquire(10);
    const waiting = gate.acquire(5);
    await expect(gate.acquire(5)).rejects.toBeInstanceOf(BusyError);
    await expect(waiting).rejects.toBeInstanceOf(BusyError);
    expect(gate.stats.queued).toBe(0);
    hold();
  });

  it("drops a waiter whose client went away, and a release twice counts once", async () => {
    const gate = new MemoryGate({ budgetBytes: 10 });
    const hold = await gate.acquire(10);
    const controller = new AbortController();
    const gone = gate.acquire(5, controller.signal);
    controller.abort();
    await expect(gone).rejects.toThrow("aborted");
    expect(gate.stats.queued).toBe(0);
    hold();
    hold();
    expect(gate.stats).toEqual({ inFlightBytes: 0, running: 0, queued: 0 });
  });
});

describe("the budget follows the machine", () => {
  it("is the machine's memory less the idle process, never under the floor", () => {
    expect(budgetForMachine(256 * MB)).toBe(256 * MB - IDLE_RESERVE_BYTES);
    expect(budgetForMachine(512 * MB)).toBe(512 * MB - IDLE_RESERVE_BYTES);
    expect(budgetForMachine(64 * MB)).toBe(MIN_BUDGET_BYTES);
  });

  it("warns when the heap is not capped below the machine", () => {
    // Node 22's default on Fly's 256 MB size, measured 2026-11-25: 259 MB heap on 210 MB.
    expect(memoryReport(98 * MB, 210 * MB, 259 * MB).warning).toMatch(/start\.sh/);
    expect(memoryReport(98 * MB, 210 * MB, 105 * MB)).toEqual({
      line: "memory: machine 210 MB, heap limit 105 MB (50%), request budget 98 MB",
      warning: null,
    });
  });
});

describe("the API queues big pages for memory", () => {
  let db: Db;
  beforeEach(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, undefined, { lock: false });
  });
  afterEach(() => db.close());

  const vectors = JSON.parse(readFileSync(new URL("../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));
  const b64 = (n: number) => randomBytes(n).toString("base64url");

  async function syncedUser(gate: MemoryGate) {
    const a = buildServer({ db, allowedOrigins: [], memoryGate: gate });
    const { rows } = await db.query<{ id: string }>("insert into users (email, plan) values ($1, 'pro') returning id", [`${b64(4)}@example.com`]);
    const token = await issueToken(db, rows[0].id);
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      a.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
    const dev = await call("POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label: "Mac" });
    const proof = vectors.epochProofs.find((p: { keyId: number }) => p.keyId === 1)?.proof ?? b64(32);
    await call("PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, proof, wraps: [{ deviceId: dev.json().deviceId, wrap: vectors.wrap.blob }] });
    const pushed = await call("POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: b64(32), revision: 1, keyId: 1, blob: b64(4096) }] });
    expect(pushed.json().results[0].status).toBe("ok");
    return call;
  }

  it("answers 503 busy with Retry-After when the page can't get room in time, then serves it once there is room", async () => {
    const gate = new MemoryGate({ budgetBytes: 4096 * PAGE_FACTOR, maxWaitMs: 30 });
    const call = await syncedUser(gate);
    const hold = await gate.acquire(1);
    const busy = await call("GET", "/v1/sync/pull");
    expect(busy.statusCode).toBe(503);
    expect(busy.headers["retry-after"]).toBe("5");
    expect(busy.json()).toEqual({ error: "busy" });
    hold();
    const ok = await call("GET", "/v1/sync/pull");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().objects).toHaveLength(1);
    // The page gave its room back once the answer was out.
    expect(gate.stats).toEqual({ inFlightBytes: 0, running: 0, queued: 0 });
  });

  it("holds a waiting page until room frees up instead of failing it", async () => {
    const gate = new MemoryGate({ budgetBytes: 4096 * PAGE_FACTOR, maxWaitMs: 5_000 });
    const call = await syncedUser(gate);
    const hold = await gate.acquire(1);
    const pull = call("GET", "/v1/sync/pull");
    while (gate.stats.queued === 0) await tick();
    hold();
    expect((await pull).statusCode).toBe(200);
    expect(gate.stats.inFlightBytes).toBe(0);
  });

  it("queues a big upload before its body is read, and lets small calls through", async () => {
    const gate = new MemoryGate({ budgetBytes: 1, maxWaitMs: 30 });
    const call = await syncedUser(gate);
    const hold = await gate.acquire(1);
    // Small: no queue even with the budget spent.
    expect((await call("GET", "/v1/sync/state")).statusCode).toBe(200);
    const big = await call("POST", "/v1/sync/push", { objects: [{ collection: "chat", objectId: b64(32), revision: 1, keyId: 1, blob: b64(256 * 1024) }] });
    expect(big.statusCode).toBe(503);
    expect(big.json()).toEqual({ error: "busy" });
    hold();
  });
});
