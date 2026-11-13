import type { FastifyInstance } from "fastify";
import { authenticate } from "./auth.js";
import type { Db } from "./db.js";

/**
 * Switches for Cloud features that aren't released yet (issue #2724). Each is
 * off until a Nekko team account turns it on: `team` shows it to team
 * accounts only, `on` to everyone. A feature the service can't run (billing
 * without Stripe keys) stays unavailable whatever its switch says.
 */
export const FEATURES = ["billing"] as const;
export type Feature = (typeof FEATURES)[number];
export type FeatureState = "off" | "team" | "on";
const STATES: ReadonlySet<string> = new Set(["off", "team", "on"]);

/** The Nekko Agent team. NEKKO_STAFF_EMAILS replaces the list. */
export const DEFAULT_STAFF_EMAILS = ["philip@nekkolabs.com", "davide@nekkolabs.com", "travis@nekkolabs.com", "matt@nekkolabs.com"];

export interface Features {
  /** Lower-case emails of team accounts. */
  staff: ReadonlySet<string>;
  /** Features this service can run (configured). */
  available: ReadonlySet<Feature>;
}

export async function featureStates(db: Db): Promise<Record<Feature, FeatureState>> {
  const { rows } = await db.query<{ key: string; state: FeatureState }>("select key, state from feature_flags");
  const states = Object.fromEntries(FEATURES.map((f) => [f, "off"])) as Record<Feature, FeatureState>;
  for (const r of rows) if ((FEATURES as readonly string[]).includes(r.key)) states[r.key as Feature] = r.state;
  return states;
}

/** A team account: on the staff list and its email proven at sign-in, so nobody can claim one by typing the address. */
export async function isStaff(db: Db, f: Features, userId: string | null): Promise<boolean> {
  if (!userId || !f.staff.size) return false;
  const { rows } = await db.query<{ email: string; email_verified: boolean }>("select lower(email) as email, email_verified from users where id = $1", [userId]);
  return !!rows[0]?.email_verified && f.staff.has(rows[0].email);
}

/** What the caller (or an anonymous visitor, `null`) sees. */
export async function featuresFor(db: Db, f: Features, userId: string | null): Promise<{ staff: boolean; features: Record<Feature, boolean> }> {
  const [states, staff] = await Promise.all([featureStates(db), isStaff(db, f, userId)]);
  const features = Object.fromEntries(FEATURES.map((k) => [k,
    f.available.has(k) && (states[k] === "on" || (states[k] === "team" && staff))])) as Record<Feature, boolean>;
  return { staff, features };
}

export function registerFeatures(app: FastifyInstance, db: Db, f: Features): void {
  // Anonymous callers (the website) see only what is on for everyone.
  app.get("/v1/features", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = req.headers.authorization ? await authenticate(db, req) : null;
    return featuresFor(db, f, caller?.userId ?? null);
  });

  app.get("/v1/staff/features", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    // A 404 rather than a 403: the route doesn't exist for anyone else.
    if (!(await isStaff(db, f, caller.userId))) return reply.code(404).send({ error: "not-found" });
    return { features: await featureStates(db), available: [...f.available] };
  });

  app.put("/v1/staff/features/:key", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await isStaff(db, f, caller.userId))) return reply.code(404).send({ error: "not-found" });
    const key = String((req.params as { key: string }).key);
    const state = (req.body as { state?: unknown } | undefined)?.state;
    if (!(FEATURES as readonly string[]).includes(key)) return reply.code(404).send({ error: "not-found" });
    if (typeof state !== "string" || !STATES.has(state)) return reply.code(400).send({ error: "bad-state", states: [...STATES] });
    await db.query(
      `insert into feature_flags (key, state, updated_by) values ($1, $2, $3)
       on conflict (key) do update set state = excluded.state, updated_by = excluded.updated_by, updated_at = now()`,
      [key, state, caller.userId],
    );
    req.log.info({ feature: key, state }, "feature switched");
    return { features: await featureStates(db), available: [...f.available] };
  });
}
