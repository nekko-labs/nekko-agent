import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueToken } from "./auth.js";
import { Stripe, planFromSubscriptions, verifySignature } from "./billing.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

const WHSEC = "whsec_test";
let db: Db;
let app: ReturnType<typeof buildServer>;
let calls: { method: string; path: string; body: string; idem?: string }[];
/** What the fake Stripe answers for the customer's subscriptions; DELETE /v1/customers fails when set. */
let subs: { status: string; items: { data: { price: { id: string } }[] } }[];
let deleteFails: boolean;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ method, path: url.pathname, body: method === "GET" ? url.search : String(init?.body ?? ""), idem: headers["idempotency-key"] });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && url.pathname === "/v1/customers") return json(200, { id: "cus_1" });
  if (method === "POST" && url.pathname === "/v1/checkout/sessions") return json(200, { url: "https://checkout.stripe.com/c/1" });
  if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") return json(200, { url: "https://billing.stripe.com/p/1" });
  if (method === "GET" && url.pathname === "/v1/prices/price_pro") return json(200, { unit_amount: 1200, currency: "usd", recurring: { interval: "month" } });
  if (method === "GET" && url.pathname === "/v1/subscriptions") return json(200, { data: subs });
  if (method === "DELETE" && url.pathname.startsWith("/v1/customers/")) return deleteFails ? json(500, { error: { message: "down" } }) : json(200, { deleted: true });
  return json(404, { error: { message: "no route" } });
};

function start(withStripe = true) {
  app = buildServer({
    db, allowedOrigins: [], publicUrl: "https://api.test",
    stripe: withStripe ? new Stripe({ secretKey: "sk_test", webhookSecret: WHSEC, prices: { pro: "price_pro" }, fetch: fakeFetch }) : undefined,
  });
}

beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  calls = [];
  subs = [];
  deleteFails = false;
  start();
});
afterEach(async () => { await app.close(); await db.close(); });

async function user(email: string, opts: { verified?: boolean; plan?: string } = {}) {
  const { rows } = await db.query<{ id: string }>("insert into users (email, plan, email_verified) values ($1, $2, $3) returning id", [email, opts.plan ?? "free", opts.verified ?? true]);
  return { id: rows[0].id, token: await issueToken(db, rows[0].id) };
}
const call = (token: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
const setBilling = async (token: string, state: string) => call(token, "PUT", "/v1/staff/features/billing", { state });
const me = async (token: string) => (await call(token, "GET", "/v1/auth/me")).json().account;

function signed(event: object, t = Math.floor(Date.now() / 1000), secret = WHSEC) {
  const body = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { body, header: `t=${t},v1=${sig}` };
}
const webhook = (s: { body: string; header: string }) => app.inject({
  method: "POST", url: "/v1/billing/webhook", payload: s.body, headers: { "content-type": "application/json", "stripe-signature": s.header },
});

describe("feature switches", () => {
  it("start off for everyone, team accounts included", async () => {
    const philip = await user("Philip@NekkoLabs.com");
    expect(await me(philip.token)).toMatchObject({ staff: true, features: { billing: false } });
    expect((await call(null, "GET", "/v1/features")).json()).toEqual({ staff: false, features: { billing: false } });
    expect((await call(philip.token, "GET", "/v1/billing/plans")).statusCode).toBe(404);
  });

  it("only a team account with a proven email can switch them, and others don't see the route", async () => {
    const someone = await user("someone@example.com");
    const unproven = await user("davide@nekkolabs.com", { verified: false });
    expect((await setBilling(someone.token, "on")).statusCode).toBe(404);
    expect((await setBilling(unproven.token, "on")).statusCode).toBe(404);
    expect((await call(someone.token, "GET", "/v1/staff/features")).statusCode).toBe(404);
    expect((await call(null, "PUT", "/v1/staff/features/billing", { state: "on" })).statusCode).toBe(401);
    expect(await me(unproven.token)).toMatchObject({ staff: false });
  });

  it("team shows billing to team accounts only; on shows it to everyone, signed in or not", async () => {
    const matt = await user("matt@nekkolabs.com");
    const someone = await user("someone@example.com");
    expect((await setBilling(matt.token, "maybe")).statusCode).toBe(400);
    expect((await call(matt.token, "PUT", "/v1/staff/features/nope", { state: "on" })).statusCode).toBe(404);
    const r = await setBilling(matt.token, "team");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ features: { billing: "team" }, available: ["billing"] });
    expect((await me(matt.token)).features.billing).toBe(true);
    expect((await me(someone.token)).features.billing).toBe(false);
    expect((await call(null, "GET", "/v1/billing/plans")).statusCode).toBe(404);

    await setBilling(matt.token, "on");
    expect((await me(someone.token)).features.billing).toBe(true);
    const plans = await call(null, "GET", "/v1/billing/plans");
    expect(plans.json()).toEqual({ plans: [{ id: "pro", amount: 1200, currency: "usd", interval: "month" }] });

    await setBilling(matt.token, "off");
    expect((await me(matt.token)).features.billing).toBe(false);
  });

  it("billing stays unavailable without Stripe, whatever the switch says", async () => {
    await app.close();
    start(false);
    const travis = await user("travis@nekkolabs.com");
    await setBilling(travis.token, "on");
    expect((await me(travis.token)).features.billing).toBe(false);
    expect((await call(travis.token, "POST", "/v1/billing/checkout", { plan: "pro" })).statusCode).toBe(404);
  });
});

describe("checkout and portal", () => {
  it("are hidden while billing is off", async () => {
    const u = await user("someone@example.com");
    expect((await call(u.token, "POST", "/v1/billing/checkout", { plan: "pro" })).statusCode).toBe(404);
    expect((await call(u.token, "POST", "/v1/billing/portal")).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("start a Pro subscription for a free account, with one Stripe customer per account", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setBilling(philip.token, "on");
    const u = await user("someone@example.com");
    expect((await call(u.token, "POST", "/v1/billing/checkout", { plan: "team" })).statusCode).toBe(400);
    const r = await call(u.token, "POST", "/v1/billing/checkout", { plan: "pro" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: "https://checkout.stripe.com/c/1" });
    expect(calls.find((c) => c.path === "/v1/customers")?.idem).toBe(`customer:${u.id}`);
    const session = new URLSearchParams(calls.find((c) => c.path === "/v1/checkout/sessions")!.body);
    expect(session.get("customer")).toBe("cus_1");
    expect(session.get("client_reference_id")).toBe(u.id);
    expect(session.get("line_items[0][price]")).toBe("price_pro");
    expect(session.get("success_url")).toBe("https://api.test/v1/billing/return?result=done");

    await call(u.token, "POST", "/v1/billing/checkout", { plan: "pro" });
    expect(calls.filter((c) => c.path === "/v1/customers")).toHaveLength(1);

    expect((await call(u.token, "POST", "/v1/billing/portal")).json()).toEqual({ url: "https://billing.stripe.com/p/1" });
  });

  it("refuses a second subscription, and a portal for a plan set by hand", async () => {
    const philip = await user("philip@nekkolabs.com", { plan: "pro" });
    await setBilling(philip.token, "team");
    expect((await call(philip.token, "POST", "/v1/billing/checkout", { plan: "pro" })).json()).toEqual({ error: "already-subscribed", plan: "pro" });
    expect((await call(philip.token, "POST", "/v1/billing/portal")).json()).toEqual({ error: "no-billing-account" });
  });
});

describe("webhook", () => {
  it("refuses an unsigned, tampered or stale event", async () => {
    const ev = { type: "customer.subscription.updated", data: { object: { customer: "cus_1" } } };
    expect((await webhook({ body: JSON.stringify(ev), header: "" })).statusCode).toBe(400);
    expect((await webhook(signed(ev, undefined, "whsec_other"))).statusCode).toBe(400);
    expect((await webhook(signed(ev, Math.floor(Date.now() / 1000) - 600))).statusCode).toBe(400);
    const s = signed(ev);
    expect((await webhook({ body: s.body.replace("cus_1", "cus_2"), header: s.header })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("sets the plan from what Stripe says now, so order and repeats don't matter", async () => {
    const u = await user("someone@example.com");
    const plan = async () => (await db.query<{ plan: string }>("select plan from users where id = $1", [u.id])).rows[0].plan;
    subs = [{ status: "active", items: { data: [{ price: { id: "price_pro" } }] } }];
    const done = { type: "checkout.session.completed", data: { object: { customer: "cus_9", client_reference_id: u.id } } };
    expect((await webhook(signed(done))).statusCode).toBe(200);
    expect(await plan()).toBe("pro");

    subs = [{ status: "canceled", items: { data: [{ price: { id: "price_pro" } }] } }];
    const deleted = { type: "customer.subscription.deleted", data: { object: { customer: "cus_9" } } };
    expect((await webhook(signed(deleted))).statusCode).toBe(200);
    expect(await plan()).toBe("free");

    // An unrelated event is acknowledged and changes nothing.
    expect((await webhook(signed({ type: "invoice.paid", data: { object: { customer: "cus_9" } } }))).statusCode).toBe(200);
  });

  it("answers 500 when Stripe can't be asked, so Stripe sends the event again", async () => {
    await user("someone@example.com");
    const broken = new Stripe({ secretKey: "sk", webhookSecret: WHSEC, prices: { pro: "price_pro" }, fetch: async () => { throw new Error("offline"); } });
    await app.close();
    app = buildServer({ db, allowedOrigins: [], stripe: broken });
    const r = await webhook(signed({ type: "customer.subscription.updated", data: { object: { customer: "cus_1" } } }));
    expect(r.statusCode).toBe(500);
  });
});

describe("account deletion", () => {
  it("cancels the subscription by deleting the Stripe customer, and deletes nothing if that fails", async () => {
    const u = await user("someone@example.com");
    await db.query("update users set stripe_customer_id = 'cus_7', plan = 'pro' where id = $1", [u.id]);
    deleteFails = true;
    const fail = await call(u.token, "DELETE", "/v1/account");
    expect(fail.statusCode).toBe(502);
    expect(fail.json()).toEqual({ error: "billing-teardown-failed" });
    expect((await db.query("select 1 from users where id = $1", [u.id])).rows).toHaveLength(1);

    deleteFails = false;
    expect((await call(u.token, "DELETE", "/v1/account")).statusCode).toBe(204);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/customers/cus_7", "/v1/customers/cus_7"]);
    expect((await db.query("select 1 from users where id = $1", [u.id])).rows).toHaveLength(0);
  });

  it("keeps a team account's switch history when the account is deleted", async () => {
    const philip = await user("philip@nekkolabs.com");
    await setBilling(philip.token, "team");
    expect((await call(philip.token, "DELETE", "/v1/account")).statusCode).toBe(204);
    expect((await db.query("select state, updated_by from feature_flags")).rows).toEqual([{ state: "team", updated_by: null }]);
  });
});

describe("pure parts", () => {
  it("verifySignature accepts any matching v1 within five minutes", () => {
    const raw = Buffer.from('{"a":1}');
    const sig = createHmac("sha256", "s").update(`1000.${raw}`).digest("hex");
    expect(verifySignature(raw, `t=1000,v1=00,v1=${sig}`, "s", 1100)).toBe(true);
    expect(verifySignature(raw, `t=1000,v1=${sig}`, "s", 1301)).toBe(false);
    expect(verifySignature(raw, `t=x,v1=${sig}`, "s", 1000)).toBe(false);
    expect(verifySignature(raw, `t=1000,v0=${sig}`, "s", 1000)).toBe(false);
  });

  it("planFromSubscriptions keeps a past-due plan and picks the higher of two", () => {
    const sub = (status: string, price: string) => ({ status, items: { data: [{ price: { id: price } }] } });
    const prices = { pro: "p", team: "t" };
    expect(planFromSubscriptions([sub("past_due", "p")], prices)).toBe("pro");
    expect(planFromSubscriptions([sub("active", "p"), sub("trialing", "t")], prices)).toBe("team");
    expect(planFromSubscriptions([sub("unpaid", "t"), sub("active", "other")], prices)).toBe("free");
  });
});
