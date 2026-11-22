import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG } from './planCatalog.js';
import { guessPaymentCountry, paymentMethodsFor } from './paymentMethods.js';

const ids = (o: Parameters<typeof paymentMethodsFor>[0]) => paymentMethodsFor(o).map((m) => m.id);

describe('payment methods by country, device and account (#3193)', () => {
  it('offers cards, the device wallet and Link in Japan, and nothing that pays one invoice at a time', () => {
    expect(ids({ country: 'JP', device: 'apple' })).toEqual(['card', 'apple_pay', 'link']);
    expect(ids({ country: 'JP', device: 'other' })).toEqual(['card', 'google_pay', 'link']);
  });

  it('adds ACH, Cash App Pay, Amazon Pay and Klarna in the United States', () => {
    expect(ids({ country: 'US', device: 'other' })).toEqual(['card', 'google_pay', 'link', 'us_bank_account', 'cashapp', 'amazon_pay', 'klarna']);
  });

  it('offers SEPA everywhere in the EEA and iDEAL only in the Netherlands', () => {
    expect(ids({ country: 'DE', device: 'apple' })).toContain('sepa_debit');
    expect(ids({ country: 'DE', device: 'apple' })).not.toContain('ideal');
    expect(ids({ country: 'NL', device: 'apple' })).toEqual(expect.arrayContaining(['sepa_debit', 'ideal']));
  });

  it('leaves out what a US Stripe account cannot offer, and adds it for an EU or UK one', () => {
    expect(ids({ country: 'GB', device: 'apple' })).not.toEqual(expect.arrayContaining(['paypal']));
    expect(ids({ country: 'GB', device: 'apple' })).not.toContain('bacs_debit');
    expect(ids({ country: 'GB', device: 'apple', merchant: 'GB' })).toEqual(expect.arrayContaining(['paypal', 'revolut_pay', 'bacs_debit']));
  });

  it('follows India\'s rules: UPI, no Google Pay, Apple Pay or Link', () => {
    expect(ids({ country: 'IN', device: 'other' })).toEqual(['card', 'upi']);
    expect(ids({ country: 'IN', device: 'apple' })).toEqual(['card', 'upi']);
  });

  it('offers Korean cards, Kakao Pay and Naver Pay in South Korea, and Pix in Brazil', () => {
    expect(ids({ country: 'KR', device: 'other' })).toEqual(expect.arrayContaining(['kr_card', 'kakao_pay', 'naver_pay']));
    expect(ids({ country: 'BR', device: 'other' })).toContain('pix');
  });

  it('offers paying by invoice only for Enterprise', () => {
    expect(ids({ country: 'US', device: 'apple' })).not.toContain('customer_balance');
    expect(ids({ country: 'US', device: 'apple', enterprise: true })).toContain('customer_balance');
  });

  it('falls back to cards, the wallet and Link anywhere else', () => {
    expect(ids({ country: 'XX', device: 'apple' })).toEqual(['card', 'apple_pay', 'link']);
  });

  it('guesses the country from the time zone, then the language, else somewhere else', () => {
    expect(guessPaymentCountry('Asia/Tokyo', ['en-US'])).toBe('JP');
    expect(guessPaymentCountry('UTC', ['de-DE'])).toBe('DE');
    expect(guessPaymentCountry('America/Chicago', ['en'])).toBe('US');
    expect(guessPaymentCountry('Africa/Lagos', ['en'])).toBe('XX');
  });
});

describe('the plan catalog (#3191)', () => {
  it('has Free, Pro and Enterprise with three main points each', () => {
    expect(PLAN_CATALOG.plans.map((p) => [p.id, p.name, p.points.length])).toEqual([['free', 'Free', 3], ['pro', 'Pro', 3], ['team', 'Enterprise', 3]]);
  });

  it('gives every row a value for every plan, and never takes away from a bigger plan', () => {
    for (const row of PLAN_CATALOG.groups.flatMap((g) => g.rows)) {
      for (const id of ['free', 'pro', 'team'] as const) expect(['boolean', 'string']).toContain(typeof row[id]);
      if (row.free === true) expect(row.pro).toBe(true);
      if (row.pro === true) expect(row.team).toBe(true);
    }
  });
});
