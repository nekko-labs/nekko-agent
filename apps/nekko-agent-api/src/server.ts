import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAccount, type SignInConfig } from "./account.js";
import type { Alert } from "./alerts.js";
import type { Db } from "./db.js";
import { registerDonations } from "./donations.js";
import { registerFeedback } from "./feedback.js";
import { registerMachines, type MachinesOptions } from "./machines.js";
import { confirmSignup, page, sendConfirmation, unsubscribe, type Mailer } from "./confirmations.js";
import { parseSignup, recordSignup } from "./signups.js";
import type { DeleteAuthUser } from "./supabase.js";
import { registerSync } from "./sync.js";

export interface ServerOptions {
  db: Db;
  /** Origins allowed to call the API from a browser, e.g. https://nekkoagent.com. */
  allowedOrigins: string[];
  /** Signups per IP per window before 429. */
  rateLimit?: { max: number; windowMs: number };
  /** Sync requests per IP per window before 429 (token checks included). */
  syncRateLimit?: { max: number; windowMs: number };
  /** Supabase Auth sign-in; without it the /v1/auth routes answer 503. */
  signIn?: SignInConfig;
  /** Sign-in exchanges per IP per window before 429. */
  authRateLimit?: { max: number; windowMs: number };
  /** Donations per IP per window before 429. */
  donationRateLimit?: { max: number; windowMs: number };
  /** Feedback notes per IP per window before 429. */
  feedbackRateLimit?: { max: number; windowMs: number };
  /** Nekko Cloud machines (decision 0017); without it the /v1/machines routes are absent. */
  machines?: MachinesOptions;
  /** Sends signup confirmation emails; without it signups still save and the email is skipped. */
  mailer?: Mailer;
  /** This service's public origin, for the links in emails. */
  publicUrl?: string;
  /** Deletes the Supabase Auth user when an account is deleted; without it the deletion waits for the retry. */
  deleteAuthUser?: DeleteAuthUser;
  /** Called on every 5xx answer (ALERT_EMAIL); summaries carry no request data. */
  alert?: Alert;
  /** Request logging, redacted (see LOG_SERIALIZERS); an object adds pino options such as a stream (tests). */
  logger?: boolean | { stream: { write(line: string): void } };
}

/**
 * What a request log line may hold: method, path, status and timing. No
 * client IP or port, no host, and no query string (the confirm and
 * unsubscribe links carry their tokens there). Errors keep their type,
 * message and stack only, not a driver's extra fields (pg's `detail` quotes
 * row values).
 */
export const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split("?")[0] }),
  err: (e: Error & { code?: unknown }) => ({ type: e.name, message: e.message, code: e.code, stack: e.stack ?? "" }),
};

export const DEFAULT_PUBLIC_URL = "https://nekko-agent-api.fly.dev";
export const DEFAULT_ORIGINS = ["https://nekkoagent.com", "https://www.nekkoagent.com"];

export function buildServer(opts: ServerOptions): FastifyInstance {
  // Fly's proxy is the one hop in front of the service; trust it for the client IP.
  const logger = opts.logger ? { serializers: LOG_SERIALIZERS, ...(typeof opts.logger === "object" ? opts.logger : {}) } : false;
  const app = Fastify({ logger, trustProxy: (_addr: string, hop: number) => hop === 0, bodyLimit: 8 * 1024 });
  const origins = new Set(opts.allowedOrigins);
  const { max, windowMs } = opts.rateLimit ?? { max: 5, windowMs: 60 * 60 * 1000 };
  const hits = new Map<string, { count: number; resetAt: number }>();

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });

  // Fastify's own 404 logs the full URL, query string included.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not-found" }));

  if (opts.alert) {
    const alert = opts.alert;
    app.addHook("onResponse", async (req, reply) => {
      if (reply.statusCode >= 500) alert(`${req.method} ${req.routeOptions.url ?? "(no route)"} answered ${reply.statusCode}`);
    });
  }

  app.options("/v1/signups", async (req, reply) => {
    if (!req.headers.origin || !origins.has(req.headers.origin)) return reply.code(403).send();
    reply
      .header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "content-type")
      .header("access-control-max-age", "86400")
      .code(204)
      .send();
  });

  // Fly's health check, and what the page calls on load to wake a stopped
  // machine before anyone presses Join.
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/signups", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return reply.code(403).send({ error: "Origin not allowed." });

    const now = Date.now();
    const hit = hits.get(req.ip);
    if (hit && hit.resetAt > now) {
      if (++hit.count > max) return reply.code(429).send({ error: "Too many signups. Try again later." });
    } else {
      hits.set(req.ip, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
    }

    const body = req.body as Record<string, unknown> | undefined;
    // Honeypot: a hidden field people never fill. Pretend it worked.
    if (body && typeof body.website === "string" && body.website !== "") return reply.code(202).send({ ok: true });

    const parsed = parseSignup(body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { id } = await recordSignup(opts.db, parsed.value);
    // A failed email never fails the signup: the row is saved, and signing up
    // again tomorrow retries.
    await sendConfirmation(opts.db, id, opts.mailer, opts.publicUrl ?? DEFAULT_PUBLIC_URL, (m) => req.log.info(m))
      .catch((e) => req.log.error(e, "confirmation email failed"));
    // Same answer for new and repeat signups, so the form can't be used to
    // check whether an address is already on the list.
    return reply.code(202).send({ ok: true });
  });

  app.get("/v1/signups/confirm", async (req, reply) => {
    const token = String((req.query as Record<string, unknown>).token ?? "");
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if ((await confirmSignup(opts.db, token)) === "confirmed") {
      return page("You're on the list", "<p>Thanks for confirming. We'll email you when your Nekko Agent beta invite is ready.</p>");
    }
    return reply.code(400).send(page("This link has expired",
      "<p>Confirm links work once and last 7 days. If you already confirmed, you're all set. Otherwise sign up again on nekkoagent.com for a fresh link.</p>"));
  });

  // One click: opening the link unsubscribes. POST is RFC 8058's one-click
  // from mail apps' own Unsubscribe button.
  const unsubscribeRoute = async (req: { query: unknown }, reply: import("fastify").FastifyReply) => {
    const token = String((req.query as Record<string, unknown>).token ?? "");
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (await unsubscribe(opts.db, token)) {
      return page("You're unsubscribed", "<p>We won't email you again. Changed your mind? Sign up again on nekkoagent.com.</p>");
    }
    return reply.code(404).send(page("Link not recognised", "<p>Email hello@nekkoagent.com and we'll remove you by hand.</p>"));
  };
  // Mail apps post a form body ("List-Unsubscribe=One-Click"); the token is in the URL.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.get("/v1/signups/unsubscribe", unsubscribeRoute);
  app.post("/v1/signups/unsubscribe", unsubscribeRoute);

  // In its own scope so the limiter covers the sync routes only. It also
  // slows anyone guessing tokens, since a 401 counts like any other answer.
  const sync = opts.syncRateLimit ?? { max: 600, windowMs: 60 * 1000 };
  // Signing in (trading a Supabase session for a device token) gets a tighter
  // limit of its own; reading the account is as cheap as any sync call.
  const auth = opts.authRateLimit ?? { max: 30, windowMs: 60 * 1000 };
  app.register(async (scope) => {
    await scope.register(rateLimit, { max: sync.max, timeWindow: sync.windowMs });
    registerSync(scope, opts.db);
    registerAccount(scope, opts.db, opts.signIn, { max: auth.max, timeWindow: auth.windowMs }, { driver: opts.machines?.driver, deleteAuthUser: opts.deleteAuthUser });
  });
  registerDonations(app, opts.db, opts.donationRateLimit ?? { max: 20, windowMs: 60 * 60 * 1000 });
  registerFeedback(app, opts.db, opts.feedbackRateLimit ?? { max: 10, windowMs: 60 * 60 * 1000 });
  if (opts.machines) registerMachines(app, opts.db, opts.machines);

  return app;
}
