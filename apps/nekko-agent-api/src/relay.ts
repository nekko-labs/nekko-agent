import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticate, type Plan } from "./auth.js";
import type { Db } from "./db.js";
import { featuresFor, type Features } from "./features.js";

/**
 * Nekko Cloud Relay (decision 0116): the hosted relay is a paid perk. The
 * relay never calls this service per connection: a signed-in device asks for
 * a short-lived ticket here, and the relay checks the ticket's Ed25519
 * signature against the public key it was started with. So the relay keeps
 * no account data and keeps working while this service (and Postgres) sleep.
 *
 * Wire format, shared with apps/relay-server/src/ticket.ts and held equal by
 * relay-ticket-vector.json in both packages:
 *
 *   nkr1.<base64url(JSON payload)>.<base64url(Ed25519 signature over "nkr1.<payload>")>
 *
 * Payload: `v` 1; `scope` "agent" (a computer claiming one relay room) or
 * "account" (the account channel: presence and content-free nudges between an
 * account's devices); `acct`, an opaque account id (a hash, never the user id
 * or email); `dev`, the device it was issued to; `room` for agent tickets;
 * `plan`; `iat` / `exp` in Unix seconds.
 */

export const TICKET_PREFIX = "nkr1";
/** How long a ticket lasts. Holders renew at half-life; a downgrade takes effect within this. */
export const TICKET_SECONDS = 6 * 60 * 60;
/** Plans whose devices may route traffic through the hosted relay. */
export const RELAY_PLANS: ReadonlySet<Plan> = new Set(["pro", "team"]);
/** A relay room code, as the computers make them (hex). */
const ROOM = /^[0-9a-f]{8,128}$/i;

export type TicketScope = "agent" | "account";

export interface TicketPayload {
  v: 1;
  scope: TicketScope;
  acct: string;
  dev: string;
  room?: string;
  plan: Plan;
  iat: number;
  exp: number;
}

export interface RelayOptions {
  /** Ed25519 private key (PKCS#8 PEM, or the 32-byte seed as base64/base64url). */
  signingKey: KeyObject;
  /** The relay devices are sent to, e.g. wss://relay.nekkoagent.com. */
  url: string;
  /** Seconds a ticket lasts; tests shorten it. */
  ticketSeconds?: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The opaque id the relay groups an account's devices under. Stable, not reversible to the user id without the table. */
export const accountChannelId = (userId: string) =>
  createHash("sha256").update(`nekko-relay-account:${userId}`).digest("base64url").slice(0, 32);

/** Reads `NEKKO_RELAY_SIGNING_KEY`: a PKCS#8 PEM, or a raw 32-byte seed in base64 or base64url. */
export function parseSigningKey(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith("-----BEGIN")) return createPrivateKey(t);
  const seed = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (seed.length !== 32) throw new Error("NEKKO_RELAY_SIGNING_KEY must be an Ed25519 PKCS#8 PEM or a 32-byte seed");
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** The public half as the relay takes it (`NEKKO_RELAY_TICKET_KEY`): the raw 32 bytes, base64url. */
export function publicKeyText(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const der = pub.export({ format: "der", type: "spki" });
  return b64u(der.subarray(der.length - 32));
}

export function signTicket(key: KeyObject, payload: TicketPayload): string {
  const body = `${TICKET_PREFIX}.${b64u(JSON.stringify(payload))}`;
  return `${body}.${b64u(sign(null, Buffer.from(body), key))}`;
}

/** Checks a ticket's signature and expiry; the payload, or null. Used by tests and kept identical to the relay's. */
export function verifyTicket(publicKey: KeyObject, ticket: string, nowSeconds = Math.floor(Date.now() / 1000)): TicketPayload | null {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
  const sig = Buffer.from(parts[2], "base64url");
  if (sig.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TicketPayload;
    return p?.v === 1 && typeof p.exp === "number" && p.exp > nowSeconds ? p : null;
  } catch {
    return null;
  }
}

export function registerRelay(app: FastifyInstance, db: Db, features: Features, opts: RelayOptions): void {
  const seconds = opts.ticketSeconds ?? TICKET_SECONDS;

  /**
   * Who may use the relay: the switch (`cloud-relay`) must show it to them,
   * and their plan must include it. A team account may use it on any plan
   * while the switch is `team`, so the team can try it before it is sold.
   */
  async function allowed(userId: string, plan: Plan): Promise<"ok" | "off" | "plan"> {
    const seen = await featuresFor(db, features, userId);
    if (!seen.features["cloud-relay"]) return "off";
    if (RELAY_PLANS.has(plan) || seen.staff) return "ok";
    return "plan";
  }

  // What the app shows before asking: whether the relay is offered to this
  // account, and whether its plan includes it (so it can offer the upgrade).
  app.get("/v1/relay", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    const state = await allowed(caller.userId, caller.plan);
    if (state === "off") return reply.code(404).send({ error: "not-found" });
    return { url: opts.url, included: state === "ok", plan: caller.plan, needs: [...RELAY_PLANS] };
  });

  app.post("/v1/relay/ticket", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) return reply.code(401).send({ error: "unauthenticated" });
    const state = await allowed(caller.userId, caller.plan);
    // A 404 while the switch is off: the route doesn't exist for this account yet.
    if (state === "off") return reply.code(404).send({ error: "not-found" });
    if (state === "plan") return reply.code(402).send({ error: "plan-required", plan: caller.plan, needs: [...RELAY_PLANS] });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = body.scope;
    if (scope !== "agent" && scope !== "account") return reply.code(400).send({ error: "bad-scope", scopes: ["agent", "account"] });
    if (Object.keys(body).some((k) => !["scope", "room"].includes(k))) return reply.code(400).send({ error: "bad-request" });
    let room: string | undefined;
    if (scope === "agent") {
      if (typeof body.room !== "string" || !ROOM.test(body.room)) return reply.code(400).send({ error: "bad-room" });
      room = body.room.toLowerCase();
    } else if (body.room !== undefined) {
      return reply.code(400).send({ error: "bad-request" });
    }
    const iat = Math.floor(Date.now() / 1000);
    const payload: TicketPayload = {
      v: 1,
      scope,
      acct: accountChannelId(caller.userId),
      // The sync device when this sign-in has one (what the fleet knows it by), else the sign-in itself.
      dev: caller.deviceId ?? `t:${caller.tokenId}`,
      ...(room ? { room } : {}),
      plan: caller.plan,
      iat,
      exp: iat + seconds,
    };
    return { ticket: signTicket(opts.signingKey, payload), expiresAt: new Date(payload.exp * 1000).toISOString(), url: opts.url, renewAfterSeconds: Math.floor(seconds / 2) };
  });
}
