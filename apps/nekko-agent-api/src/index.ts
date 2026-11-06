import { retryAuthDeletions } from "./account.js";
import { type Alert, emailAlerter } from "./alerts.js";
import { createPgDb } from "./db.js";
import { expireDonations } from "./donations.js";
import { migrate } from "./migrate.js";
import { FlyDriver } from "./fly.js";
import { sweepMachineHours } from "./machines.js";
import { resendMailer } from "./confirmations.js";
import { purgeFeedbackScreenshots, purgeSignups } from "./retention.js";
import { buildServer, DEFAULT_ORIGINS } from "./server.js";
import { supabaseAdminDeleter, supabaseVerifier } from "./supabase.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (Neon pooled connection string).");
  process.exit(1);
}

const db = createPgDb(url);
// Beta signup confirmation emails go through Resend.
const resendKey = process.env.RESEND_API_KEY;
if (!resendKey) console.warn("RESEND_API_KEY not set: signups save but no confirmation emails are sent.");
const mailer = resendKey ? resendMailer(resendKey) : undefined;
// Error alerting: one email to ALERT_EMAIL per 15 minutes at most, on a 5xx or a failed background job.
const alertTo = process.env.ALERT_EMAIL;
if (alertTo && !mailer) console.warn("ALERT_EMAIL is set but RESEND_API_KEY is not: alerts are off.");
const alert: Alert = alertTo && mailer ? emailAlerter(mailer, alertTo) : () => {};
const failed = (job: string) => (e: unknown) => {
  console.error(`${job} failed`, e);
  alert(`${job} failed`);
};
// Migrations run on every start; they are idempotent and take an advisory lock.
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
await expireDonations(db);
setInterval(() => expireDonations(db).catch(failed("expiring donations")), 24 * 60 * 60 * 1000).unref();

// Signup retention (privacy policy): unconfirmed after 30 days and
// unsubscribed rows are deleted. A failed run deletes nothing (one
// transaction) and is retried on the next tick.
const purge = () => purgeSignups(db)
  .then((n) => { if (n.unconfirmed || n.unsubscribed) console.log(`signups purged: ${n.unconfirmed} unconfirmed, ${n.unsubscribed} unsubscribed`); })
  .catch(failed("purging signups"));
await purge();
setInterval(purge, 6 * 60 * 60 * 1000).unref();

// Send feedback screenshots are deleted 90 days after their note arrived.
const purgeScreenshots = () => purgeFeedbackScreenshots(db)
  .then((n) => { if (n) console.log(`feedback screenshots purged: ${n}`); })
  .catch(failed("purging feedback screenshots"));
await purgeScreenshots();
setInterval(purgeScreenshots, 6 * 60 * 60 * 1000).unref();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;
// Sign-in: Supabase Auth proves who the caller is (SUPABASE_URL and its public
// anon / publishable key; SUPABASE_JWT_SECRET only for legacy HS256 projects).
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const signIn = supabaseUrl && supabaseAnonKey
  ? { supabaseUrl, supabaseAnonKey, verify: supabaseVerifier({ url: supabaseUrl, anonKey: supabaseAnonKey, jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined }) }
  : undefined;
if (!signIn) console.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set: sign-in is off (the /v1/auth routes answer 503).");
// Nekko Cloud machines run on Fly Machines when the app and token are set.
const flyToken = process.env.FLY_API_TOKEN;
const flyApp = process.env.FLY_MACHINES_APP;
const machines = flyToken && flyApp
  ? {
      driver: new FlyDriver({ token: flyToken, app: flyApp }),
      relayUrl: process.env.NEKKO_RELAY_URL ?? "wss://nekko-agent-relay.fly.dev",
      image: process.env.NEKKO_MACHINE_IMAGE ?? "ghcr.io/nekko-labs/nekko-agent:latest",
    }
  : undefined;
// Machine hours are counted on every state change; this also counts long-running machines and stops the ones past their plan hours.
if (machines) setInterval(() => sweepMachineHours(db, machines.driver).catch(failed("machine hours sweep")), 10 * 60 * 1000).unref();
if (!machines) console.warn("FLY_API_TOKEN / FLY_MACHINES_APP not set: Nekko Cloud machines are off (the /v1/machines routes are absent).");
// Account deletion removes the Supabase Auth user with the project's service-role key (server-side only, never sent to an app).
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const deleteAuthUser = supabaseUrl && serviceRoleKey ? supabaseAdminDeleter(supabaseUrl, serviceRoleKey) : undefined;
if (!deleteAuthUser) console.warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: deleted accounts' Supabase users wait in pending_auth_deletions.");
const retryAuth = () => retryAuthDeletions(db, deleteAuthUser).catch(failed("Supabase user deletion retry"));
await retryAuth();
setInterval(retryAuth, 60 * 60 * 1000).unref();
const app = buildServer({ db, allowedOrigins, logger: true, signIn, machines, mailer, publicUrl: process.env.PUBLIC_URL || undefined, deleteAuthUser, alert });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4320) });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
