import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, type Caller, type Plan } from "./auth.js";
import { page } from "./confirmations.js";
import type { Db } from "./db.js";
import { featuresFor, type Features } from "./features.js";

/**
 * Plans and billing on Stripe (issue #2724). Checkout starts a subscription,
 * the Customer Portal manages or cancels it, and the signed webhook keeps
 * `users.plan` in step. Every route but the webhook and the return page is
 * hidden unless the `billing` switch is on for the caller (features.ts).
 * Hand-written against Stripe's REST API, like fly.ts: no SDK.
 */
export interface StripeConfig {
  secretKey: string;
  /** The webhook endpoint's signing secret (whsec_…). */
  webhookSecret: string;
  /** Stripe price id per paid plan; a plan without one can't be bought here. */
  prices: Partial<Record<Exclude<Plan, "free">, string>>;
  fetch?: typeof fetch;
}

export class StripeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class Stripe {
  private readonly fetchImpl: typeof fetch;
  constructor(readonly cfg: StripeConfig) { this.fetchImpl = cfg.fetch ?? fetch; }

  async call<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const url = `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.secretKey}`,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: method === "POST" ? body : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    // Stripe's message names the problem, never the key.
    if (!res.ok) throw new StripeError(res.status, String(json.error?.message ?? `Stripe answered ${res.status}`).slice(0, 200));
    return json;
  }

  /** Cancels every subscription at once and removes the customer. Already gone counts as done. */
  async deleteCustomer(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/v1/customers/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof StripeError && e.status === 404)) throw e;
    }
  }
}

/** Stripe-Signature: `t=<unix>,v1=<hex hmac of "t.body">[,v1=…]`, within five minutes. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string, nowSec = Date.now() / 1000, toleranceSec = 300): boolean {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") t = v ?? "";
    else if (k === "v1" && v) sigs.push(v);
  }
  if (!/^\d+$/.test(t) || Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// Statuses that keep the plan: past_due is Stripe still retrying the card; it ends in canceled or unpaid.
const PAYING = new Set(["active", "trialing", "past_due"]);
const RANK: Record<Plan, number> = { free: 0, pro: 1, team: 2 };

interface Subscription { status: string; items: { data: { price: { id: string } }[] } }

/** The plan a customer's subscriptions pay for right now. */
export function planFromSubscriptions(subs: Subscription[], prices: StripeConfig["prices"]): Plan {
  const byPrice = new Map(Object.entries(prices).map(([plan, price]) => [price, plan as Plan]));
  let best: Plan = "free";
  for (const s of subs) {
    if (!PAYING.has(s.status)) continue;
    for (const item of s.items?.data ?? []) {
      const plan = byPrice.get(item.price?.id);
      if (plan && RANK[plan] > RANK[best]) best = plan;
    }
  }
  return best;
}

/**
 * Sets the plan from what Stripe says now, not from the event: events arrive
 * out of order and twice, and this answer is the same either way.
 */
export async function syncCustomer(db: Db, stripe: Stripe, customerId: string): Promise<Plan> {
  const list = await stripe.call<{ data: Subscription[] }>("GET", "/v1/subscriptions", { customer: customerId, status: "all", limit: "20" });
  const plan = planFromSubscriptions(list.data, stripe.cfg.prices);
  await db.query("update users set plan = $1, updated_at = now() where stripe_customer_id = $2", [plan, customerId]);
  return plan;
}

interface Price { amount: number; currency: string; interval: string }

export function registerBilling(app: FastifyInstance, db: Db, stripe: Stripe, f: Features, publicUrl: string): void {
  const prices = new Map<string, { at: number; price: Price }>();
  async function price(id: string): Promise<Price> {
    const hit = prices.get(id);
    if (hit && hit.at > Date.now() - 60 * 60 * 1000) return hit.price;
    const p = await stripe.call<{ unit_amount: number; currency: string; recurring?: { interval: string } }>("GET", `/v1/prices/${encodeURIComponent(id)}`);
    const out = { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? "month" };
    prices.set(id, { at: Date.now(), price: out });
    return out;
  }

  const visible = async (userId: string | null) => (await featuresFor(db, f, userId)).features.billing;

  /** Authenticated and billing switched on for this caller; otherwise answers and returns null. */
  async function gate(req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
    reply.header("cache-control", "no-store");
    const caller = await authenticate(db, req);
    if (!caller) { reply.code(401).send({ error: "unauthenticated" }); return null; }
    if (!(await visible(caller.userId))) { reply.code(404).send({ error: "not-found" }); return null; }
    return caller;
  }

  async function customerFor(userId: string): Promise<string> {
    const { rows } = await db.query<{ email: string; stripe_customer_id: string | null }>("select email, stripe_customer_id from users where id = $1", [userId]);
    if (rows[0].stripe_customer_id) return rows[0].stripe_customer_id;
    // The idempotency key makes two checkouts at once create one customer.
    const c = await stripe.call<{ id: string }>("POST", "/v1/customers", { email: rows[0].email, "metadata[user_id]": userId }, `customer:${userId}`);
    await db.query("update users set stripe_customer_id = $2 where id = $1 and stripe_customer_id is null", [userId, c.id]);
    const again = await db.query<{ stripe_customer_id: string }>("select stripe_customer_id from users where id = $1", [userId]);
    return again.rows[0].stripe_customer_id;
  }

  const back = (result: string) => `${publicUrl}/v1/billing/return?result=${result}`;

  // Anonymous callers (the website's pricing page) see plans only once billing is on for everyone.
  app.get("/v1/billing/plans", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const caller = req.headers.authorization ? await authenticate(db, req) : null;
    if (!(await visible(caller?.userId ?? null))) return reply.code(404).send({ error: "not-found" });
    const plans = [];
    for (const [id, priceId] of Object.entries(stripe.cfg.prices)) if (priceId) plans.push({ id, ...(await price(priceId)) });
    return { plans };
  });

  app.post("/v1/billing/checkout", async (req, reply) => {
    const caller = await gate(req, reply);
    if (!caller) return reply;
    const plan = (req.body as { plan?: unknown } | undefined)?.plan;
    const priceId = typeof plan === "string" ? stripe.cfg.prices[plan as "pro" | "team"] : undefined;
    if (!priceId) return reply.code(400).send({ error: "bad-plan" });
    // One subscription per account: changing or cancelling it is the portal's job.
    if (caller.plan !== "free") return reply.code(409).send({ error: "already-subscribed", plan: caller.plan });
    const session = await stripe.call<{ url: string }>("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer: await customerFor(caller.userId),
      client_reference_id: caller.userId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][user_id]": caller.userId,
      allow_promotion_codes: "true",
      success_url: back("done"),
      cancel_url: back("canceled"),
    });
    return { url: session.url };
  });

  app.post("/v1/billing/portal", async (req, reply) => {
    const caller = await gate(req, reply);
    if (!caller) return reply;
    const { rows } = await db.query<{ stripe_customer_id: string | null }>("select stripe_customer_id from users where id = $1", [caller.userId]);
    // A plan set by hand has nothing to manage in Stripe.
    if (!rows[0]?.stripe_customer_id) return reply.code(409).send({ error: "no-billing-account" });
    const session = await stripe.call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: rows[0].stripe_customer_id, return_url: back("managed") });
    return { url: session.url };
  });

  // Where Stripe sends the browser back to; the app picks the plan up on its next refresh.
  app.get("/v1/billing/return", async (req, reply) => {
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
    const result = String((req.query as Record<string, unknown>).result ?? "");
    if (result === "done") return page("You're all set", "<p>Thanks for subscribing to Nekko Cloud. Head back to Nekko Agent: your plan shows there in a moment.</p>");
    if (result === "canceled") return page("Nothing was charged", "<p>You left checkout before paying. Head back to Nekko Agent whenever you're ready.</p>");
    return page("Billing updated", "<p>Head back to Nekko Agent: any change to your plan shows there in a moment.</p>");
  });

  // Stripe signs the exact bytes it sent, so this scope keeps JSON bodies raw.
  app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/v1/billing/webhook", async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.headers["stripe-signature"] as string | undefined, stripe.cfg.webhookSecret)) {
        return reply.code(400).send({ error: "bad-signature" });
      }
      const event = JSON.parse(raw.toString("utf8")) as { type: string; data: { object: { customer?: string; client_reference_id?: string } } };
      const obj = event.data?.object ?? {};
      if (event.type === "checkout.session.completed" && obj.client_reference_id && obj.customer) {
        // Normally set when checkout started; this covers a customer made elsewhere.
        await db.query("update users set stripe_customer_id = $2 where id::text = $1 and stripe_customer_id is null", [obj.client_reference_id, obj.customer]);
      }
      if (obj.customer && (event.type === "checkout.session.completed" || event.type.startsWith("customer.subscription."))) {
        // A failure answers 500 and Stripe retries the event.
        const plan = await syncCustomer(db, stripe, obj.customer);
        req.log.info({ event: event.type, plan }, "billing event");
      }
      return { received: true };
    });
  });
}
