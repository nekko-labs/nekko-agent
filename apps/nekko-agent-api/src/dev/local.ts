import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../migrate.js";
import { buildServer } from "../server.js";
import { supabaseVerifier } from "../supabase.js";
import { pgliteDb } from "../test-db.js";
import { fakeGoTrue } from "./fake-gotrue.js";

/**
 * The whole Nekko Cloud API on this machine, for the apps' development and
 * end-to-end tests: Postgres in memory (PGlite, or a folder with
 * `DEV_DATA_DIR`), and a fake Supabase Auth on the same port. Nothing leaves
 * the machine.
 *
 *   npm run dev:local              # http://127.0.0.1:4330
 *   PORT=… DEV_CODE=123456 DEV_PLAN=free npm run dev:local
 *
 * Accounts start on DEV_PLAN (default pro, so sync can be tried at once).
 */
const port = Number(process.env.PORT ?? 4330);
const base = `http://127.0.0.1:${port}`;
const db = pgliteDb(new PGlite(process.env.DEV_DATA_DIR));
await migrate(db, undefined, { lock: false });

const plan = process.env.DEV_PLAN ?? "pro";
if (!["free", "pro", "team"].includes(plan)) throw new Error("DEV_PLAN must be free, pro or team");
await db.query(`alter table users alter column plan set default '${plan}'`);

let jwks: { keys: unknown[] } = { keys: [] };
const app = buildServer({
  db,
  allowedOrigins: [],
  logger: false,
  // Tests sign several devices in from one address.
  syncRateLimit: { max: 100_000, windowMs: 60_000 },
  authRateLimit: { max: 10_000, windowMs: 60_000 },
  signIn: { supabaseUrl: base, supabaseAnonKey: "dev-anon-key", verify: (t) => supabaseVerifier({ url: base, jwks })(t) },
});
({ jwks } = await fakeGoTrue(app, { baseUrl: () => base, code: process.env.DEV_CODE }));

await app.listen({ host: "127.0.0.1", port });
console.log(`Nekko Cloud (local dev) on ${base} · plan ${plan} · fake Supabase Auth on the same port`);
