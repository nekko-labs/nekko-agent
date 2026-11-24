/**
 * Which ways to pay a Nekko Cloud subscription someone has, by where they are,
 * what device they are on and what their account may do (#3193).
 *
 * This mirrors what Stripe Checkout shows in subscription mode with dynamic
 * payment methods: only methods that renew by themselves, for the payer's
 * country, that our Stripe account can offer. Checkout stays the authority;
 * this list lets the app say what to expect before the browser opens.
 * Sources (checked 2026-11-22): docs.stripe.com/payments/payment-methods/payment-method-support,
 * /payments/checkout/payment-methods, /india-recurring-payments, /payments/countries/korea.
 *
 * Left out on purpose: Konbini, bank transfer and Bancontact (one invoice at a
 * time, not automatic), Afterpay, Affirm, PayPay, Samsung Pay (no
 * subscriptions), Canadian pre-authorized debit (not in Checkout's
 * subscription mode).
 */

export type PaymentMethodKind = 'card' | 'wallet' | 'link' | 'bank' | 'app' | 'qr' | 'invoice';
export type PayerDevice = 'apple' | 'other';

export interface PaymentMethod {
  /** Stripe's payment method type. */
  id: string;
  name: string;
  kind: PaymentMethodKind;
  /** Payer countries (ISO 3166-1 alpha-2); everywhere when absent. */
  countries?: readonly string[];
  /** Payer countries it never shows in. */
  notIn?: readonly string[];
  /** Countries our Stripe account must be in to offer it; any when absent. */
  merchant?: readonly string[];
  /** Only on this kind of device. */
  device?: PayerDevice;
  /** Only for an Enterprise plan bought by an organization's owner or admin. */
  enterprise?: boolean;
  /** Where the payer finishes, for methods that hand off to another app or page. */
  handoff?: string;
}

const EEA = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'] as const;
const EU_UK_MERCHANT = [...EEA, 'CH', 'GB'];

/**
 * The country of Nekko Labs' Stripe account. Assumed to be Nekko Labs LLC
 * (US), the contracting party; PayPal, Revolut Pay, Bacs and BECS need an EU,
 * UK or Australian account and drop out with a US one.
 */
export const STRIPE_ACCOUNT_COUNTRY = 'US';

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  { id: 'card', name: 'Card', kind: 'card' },
  { id: 'kr_card', name: 'Korean card', kind: 'card', countries: ['KR'] },
  { id: 'apple_pay', name: 'Apple Pay', kind: 'wallet', device: 'apple', notIn: ['IN'] },
  { id: 'google_pay', name: 'Google Pay', kind: 'wallet', device: 'other', notIn: ['IN'] },
  { id: 'link', name: 'Link', kind: 'link', notIn: ['IN'] },
  { id: 'us_bank_account', name: 'Bank (ACH)', kind: 'bank', countries: ['US'] },
  { id: 'sepa_debit', name: 'SEPA debit', kind: 'bank', countries: EEA },
  { id: 'bacs_debit', name: 'Bacs debit', kind: 'bank', countries: ['GB'], merchant: ['GB'] },
  { id: 'au_becs_debit', name: 'BECS debit', kind: 'bank', countries: ['AU'], merchant: ['AU'] },
  { id: 'ideal', name: 'iDEAL', kind: 'app', countries: ['NL'], handoff: 'your bank\'s iDEAL page. Later months are SEPA debits from the same account' },
  { id: 'pix', name: 'Pix', kind: 'qr', countries: ['BR'], handoff: 'your bank app, to approve Pix Automático' },
  { id: 'upi', name: 'UPI', kind: 'qr', countries: ['IN'], handoff: 'your UPI app, to approve AutoPay with your PIN' },
  { id: 'kakao_pay', name: 'Kakao Pay', kind: 'app', countries: ['KR'], handoff: 'Kakao Pay' },
  { id: 'naver_pay', name: 'Naver Pay', kind: 'app', countries: ['KR'], handoff: 'Naver Pay' },
  { id: 'cashapp', name: 'Cash App Pay', kind: 'app', countries: ['US'], handoff: 'Cash App' },
  { id: 'amazon_pay', name: 'Amazon Pay', kind: 'app', countries: ['US', 'GB', 'DE', 'FR', 'NL', 'BE', 'AT', 'IE', 'IT', 'ES', 'LU', 'PT', 'SE', 'DK', 'CH', 'HU', 'CY'], handoff: 'Amazon' },
  { id: 'paypal', name: 'PayPal', kind: 'app', countries: [...EEA, 'GB', 'CH'], merchant: EU_UK_MERCHANT, handoff: 'PayPal' },
  { id: 'revolut_pay', name: 'Revolut Pay', kind: 'app', countries: [...EEA, 'GB'], merchant: EU_UK_MERCHANT, handoff: 'Revolut' },
  { id: 'klarna', name: 'Klarna', kind: 'app', countries: ['US', 'CA', 'AU', 'GB', 'DE', 'FR', 'NL', 'BE', 'AT', 'FI', 'IE', 'IT', 'ES', 'SE', 'DK', 'NO', 'PL', 'PT', 'CH'], handoff: 'Klarna, paying in full each month' },
  { id: 'customer_balance', name: 'Invoice', kind: 'invoice', enterprise: true },
];

/** A line some countries' rules call for, shown under the methods. */
export const PAYMENT_COUNTRY_NOTES: Readonly<Record<string, string>> = {
  IN: 'Your bank tells you a day before each payment, as Indian rules require.',
  BR: 'Your bank tells you a few days before each payment.',
};

/** Countries the checkout lets you pick; anywhere else gets the methods that work everywhere. */
export const PAYMENT_COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'AU', name: 'Australia' }, { code: 'AT', name: 'Austria' }, { code: 'BE', name: 'Belgium' }, { code: 'BR', name: 'Brazil' },
  { code: 'CA', name: 'Canada' }, { code: 'FR', name: 'France' }, { code: 'DE', name: 'Germany' }, { code: 'IN', name: 'India' },
  { code: 'IE', name: 'Ireland' }, { code: 'IT', name: 'Italy' }, { code: 'JP', name: 'Japan' }, { code: 'NL', name: 'the Netherlands' },
  { code: 'KR', name: 'South Korea' }, { code: 'ES', name: 'Spain' }, { code: 'GB', name: 'the United Kingdom' }, { code: 'US', name: 'the United States' },
  { code: 'XX', name: 'somewhere else' },
];

export function paymentMethodsFor({ country, device, enterprise = false, merchant = STRIPE_ACCOUNT_COUNTRY }: {
  country: string; device: PayerDevice; enterprise?: boolean; merchant?: string;
}): PaymentMethod[] {
  return PAYMENT_METHODS.filter((m) =>
    (!m.countries || m.countries.includes(country))
    && !m.notIn?.includes(country)
    && (!m.merchant || m.merchant.includes(merchant))
    && (!m.device || m.device === device)
    && (!m.enterprise || enterprise));
}

const ZONE_COUNTRY: Record<string, string> = {
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Europe/London': 'GB', 'Europe/Dublin': 'IE',
  'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'America/Sao_Paulo': 'BR', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU',
};

/**
 * A best guess at the payer's country from the time zone, then the language's
 * region ("en-US"); "XX" when neither is one we list. Only a starting point:
 * the checkout lets you change it, and Stripe decides for real.
 */
export function guessPaymentCountry(timeZone: string | undefined, languages: readonly string[] = []): string {
  const listed = (c: string | undefined) => (c && PAYMENT_COUNTRIES.some((x) => x.code === c) ? c : undefined);
  const zone = timeZone ? ZONE_COUNTRY[timeZone] : undefined;
  if (listed(zone)) return zone!;
  for (const l of languages) {
    const region = l.split('-')[1]?.toUpperCase();
    if (listed(region)) return region!;
  }
  if (timeZone?.startsWith('America/')) return 'US';
  return 'XX';
}
