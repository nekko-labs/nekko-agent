import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createBilling,
  verifyStripeSignature,
  planChangeFromEvent,
  billingConfig,
  type BillingConfig,
  type StripeEvent,
} from './billing.js';

const SECRET = 'whsec_test_secret';

function sign(rawBody: string, secret = SECRET, ts = 1_700_000_000): string {
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

const cfg: BillingConfig = {
  secretKey: 'sk_test_123',
  webhookSecret: SECRET,
  prices: { pro: 'price_pro', team: 'price_team' },
  publicUrl: 'https://cloud.nekkoagent.com',
};

describe('verifyStripeSignature', () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a correctly-signed payload', () => {
    expect(verifyStripeSignature(raw, sign(raw), SECRET, 300, 1_700_000_010)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyStripeSignature(raw + 'x', sign(raw), SECRET, 300, 1_700_000_010)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyStripeSignature(raw, sign(raw, 'whsec_other'), SECRET, 300, 1_700_000_010)).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    expect(verifyStripeSignature(raw, sign(raw, SECRET, 1_700_000_000), SECRET, 300, 1_700_999_999)).toBe(false);
  });

  it('rejects missing / malformed headers', () => {
    expect(verifyStripeSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, 'garbage', SECRET)).toBe(false);
  });
});

describe('createBilling config', () => {
  it('is disabled without a secret key and reports available plans', () => {
    expect(createBilling({ ...cfg, secretKey: undefined }).enabled).toBe(false);
    const b = createBilling(cfg);
    expect(b.enabled).toBe(true);
    expect(b.availablePlans().sort()).toEqual(['pro', 'team']);
    expect(createBilling({ ...cfg, prices: { pro: undefined, team: 'price_team' } }).availablePlans()).toEqual(['team']);
  });

  it('maps a price id back to its plan', () => {
    const b = createBilling(cfg);
    expect(b.planForPrice('price_pro')).toBe('pro');
    expect(b.planForPrice('price_team')).toBe('team');
    expect(b.planForPrice('price_unknown')).toBeUndefined();
    expect(b.planForPrice(undefined)).toBeUndefined();
  });

  it('createCheckout throws when billing is unconfigured', async () => {
    await expect(
      createBilling({ ...cfg, secretKey: undefined }).createCheckout({
        accountId: 'a',
        email: 'a@b.com',
        plan: 'pro',
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('parseWebhook returns null on a bad signature', () => {
    const raw = JSON.stringify({ id: 'evt', type: 'x', data: { object: {} } });
    expect(createBilling(cfg).parseWebhook(raw, 'bad')).toBeNull();
  });

  it('billingConfig strips trailing slashes from the public URL', () => {
    expect(billingConfig({ CLOUD_PUBLIC_URL: 'https://x.com//' } as NodeJS.ProcessEnv).publicUrl).toBe('https://x.com');
  });
});

describe('planChangeFromEvent', () => {
  const billing = createBilling(cfg);
  const ev = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: 'evt', type, data: { object } });

  it('checkout.session.completed → plan from metadata + customer + account', () => {
    const c = planChangeFromEvent(
      ev('checkout.session.completed', { client_reference_id: 'acct1', customer: 'cus_1', metadata: { plan: 'team' } }),
      billing,
    );
    expect(c).toEqual({ accountId: 'acct1', customerId: 'cus_1', plan: 'team' });
  });

  it('subscription.updated → plan from the price id', () => {
    const c = planChangeFromEvent(
      ev('customer.subscription.updated', {
        status: 'active',
        customer: 'cus_2',
        items: { data: [{ price: { id: 'price_pro' } }] },
      }),
      billing,
    );
    expect(c).toMatchObject({ customerId: 'cus_2', plan: 'pro' });
  });

  it('subscription.updated with an inactive status → free', () => {
    const c = planChangeFromEvent(ev('customer.subscription.updated', { status: 'canceled', customer: 'cus_3' }), billing);
    expect(c).toMatchObject({ customerId: 'cus_3', plan: 'free' });
  });

  it('subscription.deleted → free', () => {
    const c = planChangeFromEvent(ev('customer.subscription.deleted', { customer: 'cus_4' }), billing);
    expect(c).toMatchObject({ customerId: 'cus_4', plan: 'free' });
  });

  it('ignores unrelated events', () => {
    expect(planChangeFromEvent(ev('invoice.paid', {}), billing)).toBeNull();
  });
});
