import { createPgDb } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer, DEFAULT_ORIGINS } from "./server.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (Neon pooled connection string).");
  process.exit(1);
}

const db = createPgDb(url);
// Render's free plan has no pre-deploy step, so migrations run on start; they
// are idempotent and take an advisory lock.
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;
const app = buildServer({ db, allowedOrigins, logger: true });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4320) });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
