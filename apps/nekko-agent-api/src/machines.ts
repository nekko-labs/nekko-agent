import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, type Plan } from "./auth.js";
import type { Db } from "./db.js";
import type { MachineDriver } from "./fly.js";

/**
 * Nekko Cloud machines (decision 0017): a sandboxed machine per user that the
 * phone pairs with like any computer. This service mints the relay room, the
 * pairing key and a one-time pairing code, starts the machine with them in its
 * environment, and hands the phone the pairing link once. The key is stored
 * only as a hash, so this database can never open the machine's relay frames.
 *
 * The scope is what the phone lets the cloud see, minimal by default. The
 * machine reads it at boot (`NEKKO_CLOUD_SCOPE`); changing it restarts the
 * machine on its next start.
 */

/** Plans that may run cloud machines. */
export const MACHINE_PLANS: ReadonlySet<Plan> = new Set(["pro", "team"]);
/** Machines per account, running or stopped. */
export const MACHINE_LIMIT = 3;
/** Machine hours per month per plan. Metered by the machine's reported uptime. */
export const MACHINE_HOURS: Record<Plan, number> = { free: 0, pro: 40, team: 200 };
export const REGIONS = new Set(["nrt", "sin", "iad", "sjc", "lhr", "fra", "syd"]);
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOS = 20;
const NAME = /^[\p{L}\p{N} _.'-]{1,80}$/u;

export interface CloudScope {
  /** Repositories the machine may clone, `owner/repo`. */
  repos: string[];
  /** Privacy Shield on every cloud model request. */
  privacyShield: boolean;
  /** Memory, rules and saved prompts copied up from the user's computers (never the computers themselves). */
  memory: boolean;
  /** The machine's chats sync back to the account, end-to-end encrypted. */
  syncBack: boolean;
}

export const DEFAULT_SCOPE: CloudScope = { repos: [], privacyShield: true, memory: false, syncBack: true };

export class ScopeError extends Error {}

/** A scope as the phone sends it: every field optional, each checked. */
export function parseScope(value: unknown, base: CloudScope = DEFAULT_SCOPE): CloudScope {
  if (value === undefined) return { ...base, repos: [...base.repos] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ScopeError("scope must be an object");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!["repos", "privacyShield", "memory", "syncBack"].includes(key)) throw new ScopeError(`unknown scope field ${key}`);
  const out: CloudScope = { ...base, repos: [...base.repos] };
  if (v.repos !== undefined) {
    if (!Array.isArray(v.repos) || v.repos.length > MAX_REPOS) throw new ScopeError(`repos must be a list of at most ${MAX_REPOS}`);
    const repos: string[] = [];
    for (const r of v.repos) {
      if (typeof r !== "string" || !REPO.test(r) || r.includes("..")) throw new ScopeError("a repository is owner/repo");
      if (!repos.includes(r)) repos.push(r);
    }
    out.repos = repos;
  }
  for (const key of ["privacyShield", "memory", "syncBack"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "boolean") throw new ScopeError(`${key} must be true or false`);
      out[key] = v[key] as boolean;
    }
  }
  return out;
}

/** The hosts a machine with this scope may reach, besides the relay: GitHub and its providers' APIs. */
export function egressHosts(scope: CloudScope, providerHosts: string[] = []): string[] {
  const hosts = new Set<string>(["github.com", "api.github.com", "codeload.github.com", ...providerHosts]);
  if (!scope.repos.length) { hosts.delete("github.com"); hosts.delete("api.github.com"); hosts.delete("codeload.github.com"); }
  return [...hosts].sort();
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const b64 = (n: number) => randomBytes(n).toString("base64url");
/** A relay room: lowercase letters and digits, as the desktop's rooms are. */
const newRoom = () => randomBytes(12).toString("hex").slice(0, 20);
/** An 8-character pairing code of the alphabet the phones expect. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newPairCode(): string {
  // 32 symbols, so the top five bits of each byte pick one uniformly.
  const bytes = randomBytes(8);
  return [...bytes].map((b) => ALPHABET[b >> 3]).join("");
}

interface MachineRow {
  id: string;
  name: string;
  region: string;
  size: "small";
  state: string;
  provider_ref: string | null;
  room: string;
  scope: CloudScope;
  seconds_used: string;
  created_at: Date;
  started_at: Date | null;
  last_used_at: Date | null;
}

const COLUMNS = "id, name, region, size, state, provider_ref, room, scope, seconds_used, created_at, started_at, last_used_at";

const wire = (m: MachineRow, plan: Plan) => ({
  id: m.id,
  name: m.name,
  region: m.region,
  size: m.size,
  state: m.state,
  room: m.room,
  scope: { ...DEFAULT_SCOPE, ...m.scope },
  egress: egressHosts({ ...DEFAULT_SCOPE, ...m.scope }),
  hoursUsed: Math.round((Number(m.seconds_used) / 3600) * 10) / 10,
  hoursIncluded: MACHINE_HOURS[plan],
  createdAt: m.created_at,
  startedAt: m.started_at,
  lastUsedAt: m.last_used_at,
});

export interface MachinesOptions {
  driver: MachineDriver;
  /** The relay the machine and the phone meet on, e.g. wss://nekko-agent-relay.fly.dev. */
  relayUrl: string;
  /** The image to run, digest-pinned in production. */
  image: string;
  /** Where the phone's pairing link points (the native app's scheme). */
  pairScheme?: string;
}

export function registerMachines(app: FastifyInstance, db: Db, opts: MachinesOptions): void {
  const pairScheme = opts.pairScheme ?? "nekko-agent-pair:";

  async function guard(req: FastifyRequest, reply: FastifyReply, write: boolean): Promise<Caller | null> {
    const caller = await authenticate(db, req);
    if (!caller) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (write && !MACHINE_PLANS.has(caller.plan)) {
      reply.code(402).send({ error: "plan-required", plan: caller.plan, needs: ["pro", "team"] });
      return null;
    }
    return caller;
  }

  async function mine(caller: Caller, id: string): Promise<MachineRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await db.query<MachineRow>(`select ${COLUMNS} from cloud_machines where id = $1 and user_id = $2 and deleted_at is null`, [id, caller.userId]);
    return rows[0] ?? null;
  }

  app.get("/v1/machines", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const { rows } = await db.query<MachineRow>(`select ${COLUMNS} from cloud_machines where user_id = $1 and deleted_at is null order by created_at`, [caller.userId]);
    return { machines: rows.map((m) => wire(m, caller.plan)), relayUrl: opts.relayUrl, hoursIncluded: MACHINE_HOURS[caller.plan] };
  });

  app.post("/v1/machines", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" && NAME.test(body.name.trim()) ? body.name.trim() : "Nekko Cloud";
    const region = typeof body.region === "string" ? body.region : "nrt";
    if (!REGIONS.has(region)) return reply.code(400).send({ error: "region", regions: [...REGIONS] });
    let scope: CloudScope;
    try {
      scope = parseScope(body.scope);
    } catch (e) {
      return reply.code(400).send({ error: "scope", message: (e as Error).message });
    }
    const { rows: count } = await db.query<{ n: string }>("select count(*) as n from cloud_machines where user_id = $1 and deleted_at is null", [caller.userId]);
    if (Number(count[0].n) >= MACHINE_LIMIT) return reply.code(409).send({ error: "machine-limit", limit: MACHINE_LIMIT });

    // Minted here, handed out once: the key to the machine's environment and the phone's link; only its hash stays.
    const room = newRoom();
    // Hex, as the phone's pairing-link parser requires (the desktop's keys are hex too).
    const key = randomBytes(16).toString("hex");
    const pair = newPairCode();
    const access = `nkm_${b64(32)}`;
    const { rows } = await db.query<MachineRow>(
      `insert into cloud_machines (user_id, name, region, room, key_hash, relay_access_hash, scope)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
      [caller.userId, name, region, room, sha256(key), sha256(access), JSON.stringify(scope)],
    );
    const machine = rows[0];
    try {
      const { ref } = await opts.driver.create({
        name: `nekko-${machine.id.slice(0, 8)}`,
        region,
        image: opts.image,
        size: "small",
        env: {
          NEKKO_RELAY_URL: opts.relayUrl,
          NEKKO_ROOM: room,
          NEKKO_PAIR_KEY: key,
          NEKKO_PAIR_CODE: pair,
          NEKKO_RELAY_ACCESS: access,
          NEKKO_SANDBOX: "workspace-jail",
          NEKKO_CLOUD_SCOPE: JSON.stringify(scope),
          NEKKO_CLOUD_MACHINE: machine.id,
        },
      });
      await db.query("update cloud_machines set provider_ref = $1, state = 'running', started_at = now(), updated_at = now() where id = $2", [ref, machine.id]);
      machine.provider_ref = ref;
      machine.state = "running";
    } catch (e) {
      await db.query("update cloud_machines set state = 'failed', updated_at = now() where id = $1", [machine.id]);
      req.log.error({ err: String(e).slice(0, 200) }, "cloud machine create failed");
      return reply.code(502).send({ error: "machine-create-failed" });
    }
    const link = `${pairScheme}?relay=${encodeURIComponent(opts.relayUrl)}&room=${room}&key=${key}&pair=${pair}`;
    return reply.code(201).send({ machine: wire(machine, caller.plan), pairingLink: link, pairingCode: pair });
  });

  app.get("/v1/machines/:id", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const m = await mine(caller, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not-found" });
    if (m.provider_ref && m.state !== "deleted") {
      // The provider's word wins over ours: a machine that stopped itself when idle reads as stopped.
      const live = await opts.driver.state(m.provider_ref).catch(() => null);
      if (live && live !== "gone" && live !== m.state) {
        await db.query("update cloud_machines set state = $1, updated_at = now() where id = $2", [live, m.id]);
        m.state = live;
      }
    }
    return { machine: wire(m, caller.plan) };
  });

  app.put("/v1/machines/:id/scope", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const m = await mine(caller, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not-found" });
    let scope: CloudScope;
    try {
      scope = parseScope(req.body, { ...DEFAULT_SCOPE, ...m.scope });
    } catch (e) {
      return reply.code(400).send({ error: "scope", message: (e as Error).message });
    }
    const { rows } = await db.query<MachineRow>(`update cloud_machines set scope = $1, updated_at = now() where id = $2 returning ${COLUMNS}`, [JSON.stringify(scope), m.id]);
    return { machine: wire(rows[0], caller.plan), appliesOn: "next start" };
  });

  app.post("/v1/machines/:id/stop", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const m = await mine(caller, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not-found" });
    if (m.provider_ref) await opts.driver.stop(m.provider_ref);
    const { rows } = await db.query<MachineRow>(
      `update cloud_machines set state = 'stopped', seconds_used = seconds_used + coalesce(extract(epoch from now() - started_at), 0)::bigint, started_at = null, updated_at = now() where id = $1 returning ${COLUMNS}`,
      [m.id],
    );
    return { machine: wire(rows[0], caller.plan) };
  });

  app.post("/v1/machines/:id/start", async (req, reply) => {
    const caller = await guard(req, reply, true);
    if (!caller) return;
    const m = await mine(caller, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not-found" });
    if (Number(m.seconds_used) / 3600 >= MACHINE_HOURS[caller.plan]) return reply.code(402).send({ error: "hours-used", hoursIncluded: MACHINE_HOURS[caller.plan] });
    if (m.provider_ref) await opts.driver.start(m.provider_ref);
    const { rows } = await db.query<MachineRow>(`update cloud_machines set state = 'running', started_at = now(), last_used_at = now(), updated_at = now() where id = $1 returning ${COLUMNS}`, [m.id]);
    return { machine: wire(rows[0], caller.plan) };
  });

  app.delete("/v1/machines/:id", async (req, reply) => {
    const caller = await guard(req, reply, false);
    if (!caller) return;
    const m = await mine(caller, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not-found" });
    if (m.provider_ref) await opts.driver.destroy(m.provider_ref).catch(() => {});
    // The row stays for the hours it used; its relay access and room die with it.
    await db.query("update cloud_machines set state = 'deleted', deleted_at = now(), updated_at = now(), relay_access_hash = $2 where id = $1", [m.id, sha256(`deleted:${m.id}:${b64(8)}`)]);
    return reply.code(204).send();
  });

  /**
   * The relay's enrolment gate (`NEKKO_RELAY_AUTHZ_URL`): a machine presents
   * its access token as a Bearer; a live, undeleted machine is let in.
   */
  app.post("/v1/relay/authorize", async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!/^nkm_[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(401).send({ ok: false });
    const { rows } = await db.query<{ id: string }>(
      "update cloud_machines set last_used_at = now() where relay_access_hash = $1 and deleted_at is null and state <> 'failed' returning id",
      [sha256(token)],
    );
    if (!rows[0]) return reply.code(403).send({ ok: false });
    return { ok: true };
  });
}
