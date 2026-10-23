import { createPgDb } from "./db.js";
import { expireDonations } from "./donations.js";
import { migrate } from "./migrate.js";
import { buildServer, DEFAULT_ORIGINS } from "./server.js";
import { supabaseVerifier } from "./supabase.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (Neon pooled connection string).");
  process.exit(1);
}

const db = createPgDb(url);
// Migrations run on every start; they are idempotent and take an advisory lock.
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
await expireDonations(db);
setInterval(() => expireDonations(db).catch((e) => console.error("expiring donations failed", e)), 24 * 60 * 60 * 1000).unref();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;
// Sign-in: Supabase Auth proves who the caller is (SUPABASE_URL and its public
// anon / publishable key; SUPABASE_JWT_SECRET only for legacy HS256 projects).
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const signIn = supabaseUrl && supabaseAnonKey
  ? { supabaseUrl, supabaseAnonKey, verify: supabaseVerifier({ url: supabaseUrl, jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined }) }
  : undefined;
if (!signIn) console.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set: sign-in is off (the /v1/auth routes answer 503).");
const app = buildServer({ db, allowedOrigins, logger: true, signIn });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4320) });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
