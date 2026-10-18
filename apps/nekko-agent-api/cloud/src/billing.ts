import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Plan } from './entitlements.js';

/**
 * Nekko Cloud billing via Stripe. Hand-rolled against the Stripe REST API (no
 * SDK dependency, same dependency-free DNA as the relay's APNs/FCM senders):
 * a couple of form-encoded `fetch` POSTs plus an HMAC-SHA256 webhook-signature
 * verifier built on `node:crypto`. Everything is gated on `STRIPE_SECRET_KEY`
 * so the cloud server runs (and its tests pass) with no Stripe account; real
 * checkout/portal/webhooks only light up once the keys are configured.
 *
 * Flow:
 *  - client hits `POST /api/billing/checkout {plan}` → we open a Checkout
 *    Session for that plan's price and return its URL to redirect to.
 *  - Stripe calls `POST /api/billing/webhook` (raw body, signed) → we verify the
 *    signature, then on the relevant events update the account's plan via
 *    `store.setPlan` (entitlements gating already keys off the plan).
 *  - client hits `POST /api/billing/portal` → we open a Customer Portal session
 *    so the user can manage/cancel their subscription.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_VERSION = '2024-06-20';

/** Stripe purchasable plans (free is the default, not bought). */
export type PaidPlan = Exclude<Plan, 'free'>;

export interface BillingConfig {
  secretKey?: string;
  webhookSecret?: string;
  /** Stripe Price ids per paid plan. */
  prices: Record<PaidPlan, string | undefined>;
  /** Public base URL of the cloud app, for Checkout success/cancel redirects. */
  publicUrl: string;
}

export interface CheckoutResult {
  url: string;
}

/** A minimal slice of the Stripe event envelope we care about. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export function billingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: { pro: env.STRIPE_PRICE_PRO, team: env.STRIPE_PRICE_TEAM },
    publicUrl: (env.CLOUD_PUBLIC_URL ?? 'http://localhost:4318').replace(/\/+$/, ''),
  };
}

/**
 * Verify a Stripe webhook signature. Stripe signs `${timestamp}.${rawBody}` with
 * the endpoint secret (HMAC-SHA256) and sends `t=…,v1=…[,v1=…]` in the
 * `Stripe-Signature` header. Pure + `nowSec`-injectable for deterministic tests.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, val] = part.split('=');
    if (k === 't') t = val;
    else if (k === 'v1' && val) v1.push(val);
  }
  if (!t || v1.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return v1.some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Encode a (possibly nested) object as Stripe's bracket-style form body. */
function formEncode(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') parts.push(formEncode(value as Record<string, unknown>, k));
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
  }
  return parts.filter(Boolean).join('&');
}

export interface Billing {
  /** True once a Stripe secret key is configured. */
  enabled: boolean;
  /** Plans that have a configured price and can be purchased. */
  availablePlans(): PaidPlan[];
  /** Map a Stripe price id back to a plan (for subscription events). */
  planForPrice(priceId: string | undefined): PaidPlan | undefined;
  createCheckout(args: {
    accountId: string;
    email: string;
    plan: PaidPlan;
    customerId?: string;
  }): Promise<CheckoutResult>;
  createPortal(customerId: string): Promise<CheckoutResult>;
  /** Verify + parse a webhook payload; returns null when invalid. */
  parseWebhook(rawBody: string, signature: string | undefined): StripeEvent | null;
}

async function stripePost(secretKey: string, path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': STRIPE_VERSION,
    },
    body: formEncode(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, any>;
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? 'request failed'}`);
  return json;
}

export function createBilling(cfg: BillingConfig = billingConfig()): Billing {
  const enabled = !!cfg.secretKey;

  const planForPrice = (priceId: string | undefined): PaidPlan | undefined => {
    if (!priceId) return undefined;
    return (Object.keys(cfg.prices) as PaidPlan[]).find((p) => cfg.prices[p] === priceId);
  };

  return {
    enabled,
    availablePlans: () => (Object.keys(cfg.prices) as PaidPlan[]).filter((p) => !!cfg.prices[p]),
    planForPrice,

    async createCheckout({ accountId, email, plan, customerId }) {
      if (!cfg.secretKey) throw new Error('Billing is not configured.');
      const price = cfg.prices[plan];
      if (!price) throw new Error(`No Stripe price configured for the ${plan} plan.`);
      const session = await stripePost(cfg.secretKey, '/checkout/sessions', {
        mode: 'subscription',
        client_reference_id: accountId,
        // Reuse the customer if we know it, else let Stripe create one from the email.
        ...(customerId ? { customer: customerId } : { customer_email: email }),
        success_url: `${cfg.publicUrl}/?billing=success`,
        cancel_url: `${cfg.publicUrl}/?billing=cancel`,
        line_items: { 0: { price, quantity: 1 } },
        // Carry the account + plan on both the session and the subscription so
        // checkout.session.completed and later subscription events both resolve.
        metadata: { accountId, plan },
        subscription_data: { metadata: { accountId, plan } },
      });
      if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
      return { url: session.url as string };
    },

    async createPortal(customerId) {
      if (!cfg.secretKey) throw new Error('Billing is not configured.');
      const session = await stripePost(cfg.secretKey, '/billing_portal/sessions', {
        customer: customerId,
        return_url: `${cfg.publicUrl}/?billing=portal`,
      });
      if (!session.url) throw new Error('Stripe did not return a Portal URL.');
      return { url: session.url as string };
    },

    parseWebhook(rawBody, signature) {
      if (!cfg.webhookSecret) return null;
      if (!verifyStripeSignature(rawBody, signature, cfg.webhookSecret)) return null;
      try {
        return JSON.parse(rawBody) as StripeEvent;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve the plan-change implied by a Stripe webhook event, plus the account it
 * targets (by client_reference_id / metadata, or the Stripe customer id). Pure
 * so it can be unit-tested without a server. Returns null for events we ignore.
 */
export function planChangeFromEvent(
  event: StripeEvent,
  billing: Pick<Billing, 'planForPrice'>,
): { accountId?: string; customerId?: string; plan: Plan } | null {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const plan = (obj.metadata?.plan as Plan) ?? 'pro';
      return {
        accountId: obj.client_reference_id ?? obj.metadata?.accountId,
        customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
        plan,
      };
    }
    case 'customer.subscription.updated': {
      const status = obj.status as string;
      // Inactive subscriptions drop the account back to free.
      if (status && !['active', 'trialing', 'past_due'].includes(status)) {
        return { customerId: subCustomer(obj), accountId: obj.metadata?.accountId, plan: 'free' };
      }
      const priceId = obj.items?.data?.[0]?.price?.id as string | undefined;
      const plan = billing.planForPrice(priceId) ?? (obj.metadata?.plan as Plan | undefined);
      if (!plan) return null;
      return { customerId: subCustomer(obj), accountId: obj.metadata?.accountId, plan };
    }
    case 'customer.subscription.deleted':
      return { customerId: subCustomer(obj), accountId: obj.metadata?.accountId, plan: 'free' };
    default:
      return null;
  }
}

function subCustomer(obj: Record<string, any>): string | undefined {
  return typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
}
