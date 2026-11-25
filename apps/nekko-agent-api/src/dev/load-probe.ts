import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { issueToken } from "../auth.js";
import type { Db } from "../db.js";
import { MemoryGate } from "../memory-gate.js";
import { migrate } from "../migrate.js";
import { buildServer } from "../server.js";
import { pgliteDb } from "../test-db.js";

/**
 * A load probe for the Nekko Cloud API (the speed contract's "2.x API" row, issue #3371 and
 * friends): the real server on a real port over in-memory Postgres (PGlite), nothing leaves
 * the machine.
 *
 *   npm run probe:load                       # scenarios, exit 1 if one fails
 *   npm run probe:load -- --measure          # per-byte and latency numbers (add --expose-gc via node)
 *   node --expose-gc dist/dev/load-probe.js --measure
 *
 * Scenarios: concurrent pushes through a small memory budget (every answer is 200 or 503 busy,
 * the budget is whole again afterwards); a big pull that the client abandons and retries (the
 * first request keeps its room until its handler stops); a request that declares a huge
 * Content-Length (413 at once, nothing queued, anonymous or signed in).
 *
 * `--measure` prints peak RSS above a post-GC baseline for one pull page and the median push
 * latency at 50 and 200 objects. PGlite runs in this process, so a statement costs no network
 * round trip: latencies here understate what batching saves against Neon.
 */
const MB = 1024 * 1024;
const vectors = JSON.parse(readFileSync(new URL("../../../../crates/nekko-sync/tests/golden/sync-crypto.json", import.meta.url), "utf8"));
const b64 = (n: number) => randomBytes(n).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measure = process.argv.includes("--measure");

const db: Db = pgliteDb(new PGlite());
await migrate(db, undefined, { lock: false });

interface Client { token: string; userId: string }
async function seedUser(label: string, app: ReturnType<typeof buildServer>): Promise<Client> {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, 'pro', true) returning id", [`${label}-${b64(4)}@example.com`]);
  const token = await issueToken(db, rows[0].id);
  const call = (method: "POST" | "PUT", url: string, payload: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const dev = await call("POST", "/v1/sync/devices", { publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"), label });
  const proof = vectors.epochProofs.find((p: { keyId: number }) => p.keyId === 1)?.proof ?? b64(32);
  await call("PUT", "/v1/sync/keyrings/1", { recoveryWrap: vectors.recovery.blob, proof, wraps: [{ deviceId: dev.json().deviceId, wrap: vectors.wrap.blob }] });
  return { token, userId: rows[0].id };
}

/** Objects written straight into the table, so seeding does not go through the code under test. */
async function seedObjects(userId: string, count: number, bytes: number) {
  for (let i = 0; i < count; i++) {
    await db.query("insert into sync_objects (user_id, collection, object_id, revision, key_id, blob) values ($1, 'chat', $2, 1, 1, $3)", [userId, b64(32), randomBytes(bytes)]);
  }
}

function request(port: number, method: string, path: string, token: string | null, body?: string): Promise<{ status: number; bytes: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, (res) => {
      let bytes = 0;
      res.on("data", (c: Buffer) => { bytes += c.length; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes, ms: performance.now() - t0 }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const gate = new MemoryGate({ budgetBytes: measure ? 1024 * MB : 60 * MB, maxWaitMs: 20_000 });
const app = buildServer({ db, allowedOrigins: [], memoryGate: gate, syncRateLimit: { max: 100_000, windowMs: 60_000 } });
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as net.AddressInfo).port;

const pushBody = (n: number, size: number) => JSON.stringify({ objects: Array.from({ length: n }, () => ({ collection: "chat", objectId: b64(32), revision: 1, keyId: 1, blob: b64(size) })) });

if (!measure) {
  // 1. Concurrent pushes: 12 x 4 MB bodies (weight 12 MB each) through a 60 MB budget.
  const pushers = await Promise.all(Array.from({ length: 12 }, (_, i) => seedUser(`push${i}`, app)));
  const bodies = pushers.map(() => pushBody(1, 3 * MB));
  const results = await Promise.all(pushers.map((c, i) => request(port, "POST", "/v1/sync/push", c.token, bodies[i])));
  const statuses = results.map((r) => r.status);
  check(statuses.every((s) => s === 200 || s === 503), `concurrent pushes: every answer is 200 or 503 busy (${statuses.join(",")})`);
  check(statuses.filter((s) => s === 200).length >= 1, "concurrent pushes: some got through");
  check(gate.stats.inFlightBytes === 0 && gate.stats.queued === 0, `concurrent pushes: the budget is whole again (${JSON.stringify(gate.stats)})`);

  // 2. A big pull abandoned and retried.
  const puller = await seedUser("pull", app);
  await seedObjects(puller.userId, 16, 512 * 1024);
  const url = "/v1/sync/pull";
  const abandoned = http.get({ host: "127.0.0.1", port, path: url, headers: { authorization: `Bearer ${puller.token}` } });
  abandoned.on("error", () => {});
  await sleep(5);
  abandoned.destroy();
  const retried = await request(port, "GET", url, puller.token);
  check(retried.status === 200, `retried pull: answered ${retried.status} with ${(retried.bytes / MB).toFixed(1)} MB`);
  for (let i = 0; i < 100 && gate.stats.inFlightBytes > 0; i++) await sleep(20);
  check(gate.stats.inFlightBytes === 0 && gate.stats.running === 0, `retried pull: both requests gave their room back (${JSON.stringify(gate.stats)})`);

  // 3. A fake huge Content-Length, anonymous and signed in.
  const huge = (path: string, token: string | null) => new Promise<string>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: ${4 * 1024 * MB}\r\n${token ? `authorization: Bearer ${token}\r\n` : ""}\r\n`);
    });
    let out = "";
    s.on("data", (c) => { out += c.toString(); if (out.includes("\r\n")) { s.destroy(); resolve(out.split("\r\n")[0]); } });
    s.on("error", () => resolve("error"));
    setTimeout(() => { s.destroy(); resolve("timeout"); }, 3000).unref();
  });
  const hold = await gate.acquire(1);
  check((await huge("/v1/signups", null)).includes("413"), "huge Content-Length, anonymous: 413");
  check((await huge("/v1/sync/push", puller.token)).includes("413"), "huge Content-Length, signed in: 413");
  check(gate.stats.queued === 0, "huge Content-Length: nothing was queued");
  hold();
} else {
  const baseline = async () => { for (let i = 0; i < 3; i++) { globalThis.gc?.(); await sleep(50); } return process.memoryUsage().rss; };
  if (!globalThis.gc) console.warn("run with node --expose-gc for the per-byte numbers");
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  // Peak RSS above a post-GC baseline for one pull page, sampled every 2 ms and after the answer.
  const puller = await seedUser("rss", app);
  await seedObjects(puller.userId, 16, 512 * 1024);
  const peaks: number[] = [];
  for (let run = 0; run < 5; run++) {
    const base = await baseline();
    let peak = base;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
    const r = await request(port, "GET", "/v1/sync/pull", puller.token);
    clearInterval(t);
    peak = Math.max(peak, process.memoryUsage().rss);
    peaks.push(peak - base);
    if (run === 0) console.log(`pull page: ${(r.bytes / MB).toFixed(2)} MB of JSON on the wire`);
  }
  console.log(`pull page (8 MB of stored blobs), peak RSS above baseline, MB per run: ${peaks.map((p) => (p / MB).toFixed(1)).join(", ")}; median ${(med(peaks) / MB).toFixed(1)}`);

  // Push latency at 50 and 200 objects (4 KB each), fresh objects every run.
  for (const n of [50, 200]) {
    const c = await seedUser(`lat${n}`, app);
    const times: number[] = [];
    for (let run = 0; run < 15; run++) {
      const r = await request(port, "POST", "/v1/sync/push", c.token, pushBody(n, 4096));
      if (r.status !== 200) throw new Error(`push answered ${r.status}`);
      times.push(r.ms);
    }
    console.log(`push of ${n} objects x 4 KB: median ${med(times).toFixed(0)} ms, min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)} (15 runs)`);
  }
}

await app.close();
await db.close();
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
