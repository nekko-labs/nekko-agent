import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticate, SYNC_PLANS } from "./auth.js";
import type { Db } from "./db.js";
import { type Features, featuresFor } from "./features.js";

/**
 * CI runners P4 (decision 0064, spec/automation/ci-runners.md "Free and Nekko Cloud").
 *
 * A Mac whose owner turned on "Let the Nekko Cloud picker send jobs here" says which labels it
 * serves, for which repositories, and how many VMs are free. A picker job on a hosted runner
 * proves which repository it runs for with a GitHub Actions OIDC token and gets back the
 * `runs-on` of a free Mac, or null for a hosted runner. Nothing is stored: presence is a lease
 * in this process, like fleet presence (presence.ts), and a restart only sends jobs hosted for
 * at most one beat.
 *
 * shortcut: one process (the API is one Fly machine); a second machine needs a shared store first.
 */
export const RUNNER_LEASE_MS = 90_000;
/** How long a pick holds a free VM, so two picker jobs at once do not both pick it. */
export const HOLD_MS = 3 * 60_000;
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "nekko-cloud";
const MAX_ENTRIES = 10_000;
const MAX_RUNNERS = 8;
const MAX_REPOS = 20;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export type Guest = "macos" | "linux";
export interface RunnerPresence {
  label: string;
  /** owner/name, lower-cased. */
  repos: string[];
  free: Record<Guest, number>;
}
interface Entry { userId: string; runners: RunnerPresence[]; until: number }

/** Reads a GitHub signing key by its `kid`, or null when GitHub does not list it. */
export type Jwks = (kid: string) => Promise<JsonWebKey | null>;

/** GitHub's published OIDC keys, kept an hour; an unknown `kid` refetches at most once a minute. */
export function githubJwks(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Jwks {
  let keys = new Map<string, JsonWebKey>();
  let fetchedAt = -Infinity;
  return async (kid) => {
    const age = now() - fetchedAt;
    if (age > 60 * 60_000 || (!keys.has(kid) && age > 60_000)) {
      try {
        const r = await fetchImpl(`${OIDC_ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(5_000) });
        const body = (await r.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
        if (r.ok && Array.isArray(body.keys)) {
          keys = new Map(body.keys.filter((k) => typeof k.kid === "string").map((k) => [k.kid as string, k]));
          fetchedAt = now();
        }
      } catch {
        // Keep what we had; an unknown kid then fails closed.
      }
    }
    return keys.get(kid) ?? null;
  };
}

export interface OidcClaims { repository: string; repositoryOwner: string; eventName: string; ref: string }

const json = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** A GitHub Actions ID token's claims, or null unless it is RS256-signed by GitHub, for us, and current. */
export async function verifyOidc(token: string, jwks: Jwks, nowMs: number, audience = OIDC_AUDIENCE): Promise<OidcClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8_192) return null;
  const [h, p, s] = parts;
  const header = json(h);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const jwk = await jwks(header.kid);
  if (!jwk || jwk.kty !== "RSA") return null;
  let ok = false;
  try {
    ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  } catch {
    return null;
  }
  const c = ok ? json(p) : null;
  if (!c || c.iss !== OIDC_ISSUER) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(audience)) return null;
  const now = nowMs / 1000;
  if (typeof c.exp !== "number" || c.exp <= now || (typeof c.nbf === "number" && c.nbf > now + 60)) return null;
  if (typeof c.repository !== "string" || !REPO.test(c.repository)) return null;
  return {
    repository: c.repository.toLowerCase(),
    repositoryOwner: String(c.repository_owner ?? "").toLowerCase(),
    eventName: String(c.event_name ?? ""),
    ref: String(c.ref ?? ""),
  };
}

const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 16 ? (v as number) : null);

/** The body of `PUT /v1/runners/presence`, checked, or null. */
export function parsePresence(body: unknown): RunnerPresence[] | null {
  const list = (body as { runners?: unknown } | null)?.runners;
  if (!Array.isArray(list) || list.length > MAX_RUNNERS) return null;
  const out: RunnerPresence[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const repos = r?.repos;
    const free = r?.free as Record<string, unknown> | undefined;
    if (typeof r?.label !== "string" || !LABEL.test(r.label)) return null;
    if (!Array.isArray(repos) || repos.length > MAX_REPOS || !repos.every((x) => typeof x === "string" && REPO.test(x))) return null;
    const macos = count(free?.macos), linux = count(free?.linux);
    if (macos === null || linux === null) return null;
    out.push({ label: r.label, repos: repos.map((x: string) => x.toLowerCase()), free: { macos, linux } });
  }
  return out;
}

export class RunnerPresenceStore {
  private readonly entries = new Map<string, Entry>();
  /** `<token>|<label>|<guest>` to the expiry of each hold. */
  private readonly holds = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  set(tokenId: string, userId: string, runners: RunnerPresence[]): void {
    if (!this.entries.has(tokenId) && this.entries.size >= MAX_ENTRIES) this.sweep();
    if (!this.entries.has(tokenId) && this.entries.size >= MAX_ENTRIES) return;
    this.entries.set(tokenId, { userId, runners, until: this.now() + RUNNER_LEASE_MS });
  }

  delete(tokenId: string): void {
    this.entries.delete(tokenId);
  }

  /** The `runs-on` of a live runner with the label that serves the repository and has a VM free after holds, holding it. */
  pick(repository: string, label: string, guest: Guest): string[] | null {
    const now = this.now();
    let best: { key: string; free: number } | null = null;
    for (const [token, e] of this.entries) {
      if (e.until <= now) continue;
      for (const r of e.runners) {
        if (r.label !== label || !r.repos.includes(repository)) continue;
        const key = `${token}|${label}|${guest}`;
        const held = (this.holds.get(key) ?? []).filter((t) => t > now);
        this.holds.set(key, held);
        const free = r.free[guest] - held.length;
        if (free > 0 && (!best || free > best.free)) best = { key, free };
      }
    }
    if (!best) return null;
    this.holds.get(best.key)?.push(now + HOLD_MS);
    return guest === "linux" ? ["self-hosted", `${label}-linux`] : ["self-hosted", label];
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.until <= now) this.entries.delete(k);
    for (const [k, h] of this.holds) if (!h.some((t) => t > now)) this.holds.delete(k);
  }
}

export interface RunnersOptions { store?: RunnerPresenceStore; jwks?: Jwks; now?: () => number }

export function registerRunners(app: FastifyInstance, db: Db, features: Features, opts: RunnersOptions = {}): void {
  const store = opts.store ?? new RunnerPresenceStore();
  const jwks = opts.jwks ?? githubJwks();
  const now = opts.now ?? Date.now;
  /** The caller, when the feature is on for them and their plan includes it; replies itself otherwise. */
  const gate = async (req: Parameters<typeof authenticate>[1], reply: { code: (n: number) => { send: (b: unknown) => unknown } }, paid: boolean) => {
    const caller = await authenticate(db, req);
    if (!caller) return void reply.code(401).send({ error: "unauthorized" });
    if (!(await featuresFor(db, features, caller.userId)).features["ci-fleet"]) return void reply.code(404).send({ error: "not-found" });
    if (paid && !SYNC_PLANS.has(caller.plan)) return void reply.code(402).send({ error: "plan-required", plan: caller.plan, needs: ["pro", "team"] });
    return caller;
  };

  app.put("/v1/runners/presence", async (req, reply) => {
    const caller = await gate(req, reply, true);
    if (!caller) return;
    const runners = parsePresence(req.body);
    if (!runners) return reply.code(400).send({ error: "bad-presence" });
    store.set(caller.tokenId, caller.userId, runners);
    return { leaseSeconds: RUNNER_LEASE_MS / 1000 };
  });

  // Withdrawing never needs a plan, so a downgraded Mac can still take itself out.
  app.delete("/v1/runners/presence", async (req, reply) => {
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    store.delete(caller.tokenId);
    return reply.code(204).send();
  });

  // The picker never fails a workflow, so every refusal here is just "use a hosted runner".
  app.post("/v1/runners/pick", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const claims = header.startsWith("Bearer ") ? await verifyOidc(header.slice(7).trim(), jwks, now()) : null;
    if (!claims) return reply.code(401).send({ error: "bad-token", runsOn: null });
    const body = (req.body ?? {}) as { label?: unknown; guest?: unknown };
    const guest: Guest = body.guest === "linux" ? "linux" : "macos";
    if (typeof body.label !== "string" || !LABEL.test(body.label)) return reply.code(400).send({ error: "bad-label", runsOn: null });
    return { runsOn: store.pick(claims.repository, body.label, guest) };
  });
}
