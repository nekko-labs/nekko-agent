import { useEffect, useMemo, useState } from 'react';
import {
  type BillingPlan, type CatalogPlanId, type CatalogValue, type PayerDevice, type PaymentMethod, PAYMENT_COUNTRIES, PAYMENT_COUNTRY_NOTES,
  PLAN_CATALOG, cloudError, guessPaymentCountry, paymentMethodsFor,
} from '@nekko-agent/shared';
import { price } from './PlanAndBilling.js';

export type PlanChoice = CatalogPlanId;

/** Shown while Stripe isn't live: the draft Pro price (spec-web-and-hosted.md §6). */
export const TEST_PRO: BillingPlan = { id: 'pro', amount: 1200, currency: 'usd', interval: 'month' };
const TEAM_EMAIL = 'mailto:hello@nekkoagent.com?subject=Nekko%20Cloud%20Enterprise';
/** How long the test checkout pretends to talk to the bank. */
export const TEST_PAY_MS = 1500;

/** "$12" and "a month" from a Stripe price. */
function priceParts(p: BillingPlan): [string, string] {
  const s = price(p);
  const m = / (a \w+)$/.exec(s);
  return m ? [s.slice(0, m.index), m[1]!] : [s, ''];
}

/**
 * Choose a plan (#3191): Free, Pro and Enterprise side by side, each with its
 * three main points from the shared plan catalog, and the full comparison
 * behind Show the full list. With billing live for the account, Pro opens the
 * real Stripe Checkout in the browser; otherwise it goes to the test checkout.
 */
export function PlanStep({ live, onFree, onPro, onError }: {
  live: boolean; onFree: () => void; onPro: (plan: BillingPlan) => void; onError: (e: string) => void;
}) {
  const [choice, setChoice] = useState<PlanChoice>('pro');
  const [pro, setPro] = useState<BillingPlan | null>(live ? null : TEST_PRO);
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!live) return;
    let on = true;
    window.nekko.cloudBillingPlans()
      .then((r) => { if (on) setPro(r.plans.find((p) => p.id === 'pro') ?? null); })
      .catch((e) => { if (on) onError(cloudError(e)); });
    return () => { on = false; };
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const plans = PLAN_CATALOG.plans;
  const priceFor = (kind: string): [string, string] =>
    kind === 'free' ? [new Intl.NumberFormat(undefined, { style: 'currency', currency: (pro?.currency ?? 'usd').toUpperCase(), maximumFractionDigits: 0 }).format(0), '']
      : kind === 'contact' ? ['Talk to us', ''] : pro ? priceParts(pro) : ['…', ''];

  const go = () => {
    if (choice === 'free') onFree();
    else if (choice === 'pro' && pro) onPro(pro);
    else if (choice === 'team') void window.nekko.openPath(TEAM_EMAIL);
  };
  const move = (from: PlanChoice, step: number) => {
    const i = plans.findIndex((p) => p.id === from);
    return plans[(i + step + plans.length) % plans.length]!.id;
  };

  return (
    <>
      <h1 id="cw-title">Choose a plan</h1>
      <p className="cloud-lede">Everything on this computer stays free. Pro brings your way to every device.</p>
      <div className="cw-plans cw-stagger" role="radiogroup" aria-label="Plan" data-testid="cw-plans">
        {plans.map((p) => {
          const [amount, per] = priceFor(p.price);
          return (
            <button key={p.id} type="button" role="radio" aria-checked={choice === p.id} className="cw-plan" data-testid={`cw-plan-${p.id}`}
              tabIndex={choice === p.id ? 0 : -1} onClick={() => setChoice(p.id)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = move(choice, step);
                setChoice(next);
                (e.currentTarget.parentElement?.querySelector(`[data-testid="cw-plan-${next}"]`) as HTMLElement | null)?.focus();
              }}>
              <span className="cw-plan-top">
                <span className="cw-tick" aria-hidden="true">{choice === p.id && <TickGlyph />}</span>
                <span className="cw-plan-name">{p.name}</span>
              </span>
              <span className="cw-plan-price" data-testid={`cw-price-${p.id}`}>{amount}{per && <small>{per}</small>}</span>
              <span className="cw-plan-tag">{p.tagline}</span>
              <ul className="cw-plan-points">
                {p.points.map((x) => <li key={x}><CheckGlyph /><span>{x}</span></li>)}
              </ul>
            </button>
          );
        })}
      </div>
      <button type="button" className="cw-more" aria-expanded={full} aria-controls="cw-full-list" onClick={() => setFull((f) => !f)} data-testid="cw-full-toggle">
        <span>{full ? 'Hide the full list' : 'Show the full list'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className={`cw-fold${full ? ' is-open' : ''}`} id="cw-full-list" aria-hidden={!full} data-testid="cw-full-list">
        <div>{full && <PlanTable chosen={choice} />}</div>
      </div>
      <button className="btn btn-primary mt-(--q-group) w-full" disabled={choice === 'pro' && !pro} onClick={go} data-testid="cw-plan-continue">
        {choice === 'free' ? 'Continue with Free' : choice === 'pro' ? 'Continue with Pro' : 'Email us'}
      </button>
    </>
  );
}

/** The full comparison, every row of the catalog, with the chosen plan's column washed. */
export function PlanTable({ chosen }: { chosen: PlanChoice }) {
  const ids: PlanChoice[] = ['free', 'pro', 'team'];
  const cell = (v: CatalogValue, id: PlanChoice) => {
    const cls = `${id === chosen ? 'is-chosen ' : ''}${v === false ? 'is-no' : typeof v === 'string' ? 'is-value' : ''}`;
    return <span key={id} className={cls}>{v === true ? <CheckGlyph label="Included" /> : v === false ? <span aria-label="Not included">–</span> : v}</span>;
  };
  let i = 0;
  const delay = () => ({ animationDelay: `${Math.min(i++, 24) * 20}ms` });
  return (
    <div className="cw-table" role="table" aria-label="Every plan, feature by feature" data-testid="cw-table">
      <div className="cw-th" role="row" style={delay()}>
        <span role="columnheader" />
        {PLAN_CATALOG.plans.map((p) => <span key={p.id} role="columnheader" className={p.id === chosen ? 'is-chosen' : ''}>{p.name}</span>)}
      </div>
      {PLAN_CATALOG.groups.map((g) => (
        <div key={g.name} role="rowgroup">
          <div className="cw-tg" role="row" style={delay()}>
            <span role="rowheader">{g.name}</span>
            {ids.map((id) => <span key={id} className={id === chosen ? 'is-chosen' : ''} />)}
          </div>
          {g.rows.map((r) => (
            <div key={r.feature} className="cw-tr" role="row" style={delay()}>
              <span role="rowheader">{r.feature}{r.soon && <span className="cw-soon">Soon</span>}</span>
              {ids.map((id) => cell(r[id], id))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function guessDevice(): PayerDevice {
  if (typeof navigator === 'undefined') return 'other';
  const p = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '') + ' ' + navigator.userAgent;
  return /Mac|iPhone|iPad|iOS/i.test(p) ? 'apple' : 'other';
}

function guessCountry(): string {
  if (typeof Intl === 'undefined') return 'XX';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  return guessPaymentCountry(zone, langs);
}

const TEST_ACCOUNT: Record<string, string> = {
  us_bank_account: 'Checking •••• 6789', sepa_debit: 'DE89 •••• •••• 3000', bacs_debit: '10-88-00 •••• 2345', au_becs_debit: '000-000 •••• 3456',
};

/**
 * The test checkout (#3193): the ways to pay where you are, as tiles, and a
 * picture of how the chosen one goes. Country and device are guessed and can
 * be changed. Nothing here takes card or bank details, and nothing leaves this
 * computer: Pay now only pretends, and the account's plan does not change.
 */
export function TestCheckout({ plan, email, onPaid, onState, initialCountry, initialDevice }: {
  plan: BillingPlan; email: string; onPaid: () => void; onState?: (s: 'ready' | 'paying' | 'paid') => void;
  initialCountry?: string; initialDevice?: PayerDevice;
}) {
  const [state, setState] = useState<'ready' | 'paying' | 'paid'>('ready');
  const [country, setCountry] = useState(() => initialCountry ?? guessCountry());
  const [device, setDevice] = useState<PayerDevice>(() => initialDevice ?? guessDevice());
  const methods = useMemo(() => paymentMethodsFor({ country, device }), [country, device]);
  const [chosenId, setChosenId] = useState<string>(methods[0]!.id);
  const [all, setAll] = useState(false);
  const chosen = methods.find((m) => m.id === chosenId) ?? methods[0]!;
  useEffect(() => { onState?.(state); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state !== 'paying') return;
    const t = setTimeout(() => setState('paid'), TEST_PAY_MS);
    return () => clearTimeout(t);
  }, [state]);

  // The chosen method is always on show: it takes the third tile when it would sit behind "more".
  let shown = all || methods.length <= 4 ? methods : methods.slice(0, 3);
  if (!shown.includes(chosen)) shown = [...shown.slice(0, 2), chosen];
  const hidden = methods.length - shown.length;
  const direct = chosen.kind === 'card' || chosen.kind === 'bank' || chosen.kind === 'link';

  if (state === 'paid') {
    return (
      <div className="cw-body-in pt-(--q-group)" data-testid="cw-checkout" data-state="paid">
        <div className="cw-paid" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 30 30"><path d="M8 15.5l4.5 4.5 9.5-10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <h1 id="cw-title" className="mt-(--q-group)">You're on Pro</h1>
        <p className="cloud-lede text-info-text!" data-testid="cw-test-note">Test mode: nothing was charged and your account's plan hasn't changed.</p>
        <button className="btn btn-primary mt-(--q-group) w-full" onClick={onPaid} data-testid="cw-paid-continue">Continue</button>
      </div>
    );
  }

  return (
    <div data-testid="cw-checkout" data-state={state} data-country={country}>
      <h1 id="cw-title" className="sr-only">Pay for Nekko Cloud Pro</h1>
      <div className="cw-pay-sum"><b>Nekko Cloud Pro</b><span>{price(plan)}</span></div>
      <div className="cw-where">
        <span>Paying from</span>
        <select aria-label="Country" value={country} disabled={state === 'paying'} onChange={(e) => { setCountry(e.target.value); setAll(false); }} data-testid="cw-country">
          {PAYMENT_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <span>on</span>
        <select aria-label="Device" value={device} disabled={state === 'paying'} onChange={(e) => setDevice(e.target.value as PayerDevice)} data-testid="cw-device">
          <option value="apple">a Mac, iPhone or iPad</option>
          <option value="other">Windows, Linux or Android</option>
        </select>
      </div>
      <div className={`cw-tiles${all ? ' is-all' : ''}`} role="group" aria-label="Payment method" data-testid="cw-methods">
        {shown.map((m) => (
          <button key={m.id} type="button" className="cw-tile" aria-checked={m === chosen} role="radio" disabled={state === 'paying'}
            onClick={() => setChosenId(m.id)} data-testid={`cw-method-${m.id}`}>
            <MethodGlyph kind={m.kind} /><span>{m.name}</span>
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" className="cw-tile is-more" onClick={() => setAll(true)} data-testid="cw-methods-more">
            <MoreGlyph /><span>{hidden} more</span>
          </button>
        )}
      </div>
      <div className="cw-pv" key={`${chosen.id}:${country}`} data-testid="cw-preview" data-kind={chosen.kind}>
        <MethodPreview method={chosen} plan={plan} email={email} country={country} paying={state === 'paying'} />
      </div>
      {PAYMENT_COUNTRY_NOTES[country] && <p className="cw-pay-note">{PAYMENT_COUNTRY_NOTES[country]}</p>}
      <button className="btn btn-primary mt-(--q-group) w-full" disabled={state === 'paying'} onClick={() => setState('paying')} data-testid="cw-pay">
        {state === 'paying' ? <><span className="cw-spin" aria-hidden="true" />Paying…</> : direct ? 'Pay now' : `Continue to ${chosen.name}`}
      </button>
      <p className="cw-test-chip mt-(--q-inline)">Test mode: nothing is charged</p>
    </div>
  );
}

function MethodPreview({ method, plan, email, country, paying }: { method: PaymentMethod; plan: BillingPlan; email: string; country: string; paying: boolean }) {
  const amount = priceParts(plan)[0];
  if (method.kind === 'card') {
    const jcb = country === 'JP' && method.id === 'card';
    return (
      <div className="cw-card-wrap">
        <div className={`cw-card${paying ? ' is-paying' : ''}`} role="img" aria-label={`Test card ending in ${jcb ? '0505' : '4242'}`}>
          <div className="cw-card-top"><span>Test card</span><span>{method.id === 'kr_card' ? 'Korean card' : jcb ? 'JCB' : 'Visa'}</span></div>
          <div className="cw-card-chip" />
          <TypedNumber text={jcb ? '3566 0020 2036 0505' : '4242 4242 4242 4242'} />
          <div className="cw-card-bottom"><span className="truncate">{email}</span><span>12/34</span></div>
        </div>
      </div>
    );
  }
  if (method.kind === 'wallet') {
    return (
      <div className="cw-sheet" aria-hidden="true">
        <div><span>{method.name}</span><span>{price(plan)}</span></div>
        <div><span>Nekko Cloud Pro</span><span>every month</span></div>
        <div><span>Card</span><span>•••• 4242</span></div>
        <span className="cw-sheet-confirm">{method.id === 'apple_pay' ? 'Confirm with Touch ID' : 'Continue'}</span>
      </div>
    );
  }
  if (method.kind === 'link') {
    return <div className="cw-mandate"><div className="cw-mandate-acct"><MethodGlyph kind="link" />{email}</div>Your card and details saved with Link fill in for you. Visa •••• 4242.</div>;
  }
  if (method.kind === 'bank') {
    return (
      <div className="cw-mandate">
        <div className="cw-mandate-acct"><MethodGlyph kind="bank" />{TEST_ACCOUNT[method.id] ?? '•••• 0000'}</div>
        You allow Nekko Labs to take {amount} from this account each month for Nekko Cloud Pro, until you cancel. Your bank can refund a payment you didn't expect.
      </div>
    );
  }
  return (
    <div className="cw-hand">
      <span className="cw-hand-box"><MethodGlyph kind={method.kind} /></span>
      <svg className="cw-hand-arrow" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 9h11M10 5l4 4-4 4" /></svg>
      <span>You'll finish in {method.handoff ?? method.name}.</span>
    </div>
  );
}

/** The card number types itself in, 28ms a character; at once with reduced motion. */
function TypedNumber({ text }: { text: string }) {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (n >= text.length) return;
    const t = setTimeout(() => setN((x) => x + 1), n === 0 ? 450 : 28);
    return () => clearTimeout(t);
  }, [n, text.length]);
  return <div className="cw-card-num" aria-hidden="true">{text.slice(0, n)}<span className="cw-card-num-rest">{text.slice(n)}</span></div>;
}

function MethodGlyph({ kind }: { kind: PaymentMethod['kind'] }) {
  const common = { viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (kind) {
    case 'card': return <svg {...common}><rect x="2" y="4" width="14" height="10" rx="2" /><path d="M2 7.5h14M5 11h3" /></svg>;
    case 'wallet': return <svg {...common}><rect x="5" y="2" width="8" height="14" rx="2" /><path d="M7.5 9.2l1.2 1.2 2.2-2.4" /></svg>;
    case 'link': return <svg {...common}><path d="M10 2.5L4.5 10H9l-1 5.5L13.5 8H9z" /></svg>;
    case 'bank': return <svg {...common}><path d="M2.5 7L9 3l6.5 4zM4 8v5M7 8v5M11 8v5M14 8v5M2.5 15h13" /></svg>;
    case 'qr': return <svg {...common}><rect x="2.5" y="2.5" width="5" height="5" rx="1" /><rect x="10.5" y="2.5" width="5" height="5" rx="1" /><rect x="2.5" y="10.5" width="5" height="5" rx="1" /><path d="M10.5 10.5h2v2M15.5 10.5v5h-5" /></svg>;
    case 'invoice': return <svg {...common}><path d="M4 2.5h7l3 3v10H4z" /><path d="M6.5 8h5M6.5 11h5" /></svg>;
    default: return <svg {...common}><rect x="2.5" y="2.5" width="13" height="13" rx="3.5" /><path d="M7 11l4-4M7.5 7H11v3.5" /></svg>;
  }
}

function MoreGlyph() {
  return <svg viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="9" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="13.5" cy="9" r="1.3" /></svg>;
}

function CheckGlyph({ label }: { label?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TickGlyph() {
  return <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
