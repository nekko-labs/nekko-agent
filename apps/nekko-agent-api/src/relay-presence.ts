import { accountChannelId } from "./relay.js";

/**
 * Online computers according to the relay (docs: spec/platform/organizations.md).
 *
 * The relay already knows which devices have an account-channel socket open. When
 * `NEKKO_RELAY_PRESENCE_URL` and `NEKKO_RELAY_PRESENCE_SECRET` are set, the fleet lists also
 * count a computer online when the relay says so, which covers clients that stopped sending API
 * heartbeats. The relay's side of the contract:
 *
 *   GET <url>/presence?acct=<hash>[&acct=<hash>...]
 *   authorization: Bearer <secret>
 *   200 {"online": {"<acctHash>": ["<deviceId>", ...]}}
 *
 * `<hash>` is `accountChannelId(userId)` (relay.ts), the opaque id the relay groups devices
 * under; `<deviceId>` is the sync device id the fleet knows computers by. The API asks once per
 * fleet read, never per heartbeat, and remembers each answer for about 5 s. The relay is an extra
 * source, never a requirement: any failure (timeout, non-200, bad body) counts as "the relay knows
 * nothing" and the lease alone decides, also for the next 5 s so a slow relay cannot slow every read.
 */
export const RELAY_PRESENCE_TTL_MS = 5_000;
const TIMEOUT_MS = 1_500;
const CHUNK = 50;

export interface RelayPresenceOptions {
  /** The relay's base URL (or its full `/presence` URL). */
  url: string;
  /** The shared secret the relay checks; never logged. */
  secret: string;
  ttlMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with a short message when the relay could not be asked (no secret, no URL). */
  warn?: (message: string) => void;
}

/** Plain http is for the relay on Fly's private network or this machine; anything public must be https. */
const privateHost = (host: string) => host === "localhost" || host.startsWith("127.") || host === "[::1]" || host.endsWith(".internal") || host.endsWith(".flycast");

export class RelayPresence {
  private readonly endpoint: URL;
  private readonly secret: string;
  private readonly ttl: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; devices: Set<string> | null }>();

  constructor(opts: RelayPresenceOptions) {
    const url = new URL(opts.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost(url.hostname))) {
      throw new Error("NEKKO_RELAY_PRESENCE_URL must be https (http only for localhost, .internal or .flycast)");
    }
    if (!opts.secret) throw new Error("NEKKO_RELAY_PRESENCE_SECRET is empty");
    if (!url.pathname.replace(/\/+$/, "").endsWith("/presence")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/presence`;
    url.search = "";
    this.endpoint = url;
    this.secret = opts.secret;
    this.ttl = opts.ttlMs ?? RELAY_PRESENCE_TTL_MS;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** From the environment, or null when presence from the relay is off. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = console.warn): RelayPresence | null {
    const url = env.NEKKO_RELAY_PRESENCE_URL;
    if (!url) return null;
    const secret = env.NEKKO_RELAY_PRESENCE_SECRET;
    if (!secret) {
      warn("NEKKO_RELAY_PRESENCE_URL is set but NEKKO_RELAY_PRESENCE_SECRET is not: presence from the relay is off.");
      return null;
    }
    try {
      return new RelayPresence({ url, secret });
    } catch (e) {
      warn(`${(e as Error).message}: presence from the relay is off.`);
      return null;
    }
  }

  /**
   * A lookup for these accounts: is this account's device online at the relay. One request for
   * the accounts not answered in the last few seconds; never throws.
   */
  async lookup(userIds: Iterable<string>): Promise<(userId: string, deviceId: string) => boolean> {
    const hashes = new Map<string, string>();
    for (const u of new Set(userIds)) hashes.set(u, accountChannelId(u));
    const t = this.now();
    const stale = [...new Set(hashes.values())].filter((h) => {
      const c = this.cache.get(h);
      return !c || t - c.at >= this.ttl;
    });
    for (let i = 0; i < stale.length; i += CHUNK) await this.ask(stale.slice(i, i + CHUNK), t);
    return (userId, deviceId) => {
      const h = hashes.get(userId);
      return !!h && !!this.cache.get(h)?.devices?.has(deviceId);
    };
  }

  private async ask(hashes: string[], at: number): Promise<void> {
    let answer: Record<string, Set<string>> | null = null;
    try {
      const url = new URL(this.endpoint);
      for (const h of hashes) url.searchParams.append("acct", h);
      const res = await this.doFetch(url, { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { online?: Record<string, unknown> };
        if (body && typeof body.online === "object" && body.online !== null) {
          answer = {};
          for (const h of hashes) {
            const ids = body.online[h];
            answer[h] = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
          }
        }
      }
    } catch {
      answer = null;
    }
    if (this.cache.size > 10_000) this.cache.clear();
    // Failure is remembered too (as "unknown"), so a relay that is down costs one wait per few seconds.
    for (const h of hashes) this.cache.set(h, { at, devices: answer ? answer[h] : null });
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Presence from the relay, when configured. */
    relayPresence: RelayPresence | null;
  }
}
