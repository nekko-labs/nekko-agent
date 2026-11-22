import { useEffect, useState } from 'react';
import { type BillingPlan, cloudError } from '@nekko-agent/shared';
import { price } from './PlanAndBilling.js';

export type PlanChoice = 'free' | 'pro' | 'team';

/** Shown while Stripe isn't live: the draft Pro price (spec-web-and-hosted.md §6). */
export const TEST_PRO: BillingPlan = { id: 'pro', amount: 1200, currency: 'usd', interval: 'month' };
const TEAM_EMAIL = 'mailto:hello@nekkoagent.com?subject=Nekko%20Cloud%20Team';
/** How long the test checkout pretends to talk to the bank. */
export const TEST_PAY_MS = 1500;

/**
 * Choose a plan: rows, the chosen one on the accent wash with a check.
 * With billing live for the account, Pro opens the real Stripe Checkout in
 * the browser; otherwise it goes to the test checkout below (#3187).
 */
export function PlanStep({ live, onFree, onPro, onError }: {
  live: boolean; onFree: () => void; onPro: (plan: BillingPlan) => void; onError: (e: string) => void;
}) {
  const [choice, setChoice] = useState<PlanChoice>('pro');
  const [pro, setPro] = useState<BillingPlan | null>(live ? null : TEST_PRO);

  useEffect(() => {
    if (!live) return;
    let on = true;
    window.nekko.cloudBillingPlans()
      .then((r) => { if (on) setPro(r.plans.find((p) => p.id === 'pro') ?? null); })
      .catch((e) => { if (on) onError(cloudError(e)); });
    return () => { on = false; };
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: { id: PlanChoice; name: string; detail: string; price: string }[] = [
    { id: 'free', name: 'Free', detail: 'Your account. Chats stay on this computer.', price: formatFree(pro) },
    { id: 'pro', name: 'Pro', detail: 'Synced chats, Nekko Cloud machines, organizations.', price: pro ? price(pro) : '…' },
    { id: 'team', name: 'Team', detail: 'Pro for everyone on your team. Talk to us.', price: 'Per seat' },
  ];

  const go = () => {
    if (choice === 'free') onFree();
    else if (choice === 'pro' && pro) onPro(pro);
    else if (choice === 'team') void window.nekko.openPath(TEAM_EMAIL);
  };

  return (
    <>
      <h1 id="cw-title">Choose a plan</h1>
      <p className="cloud-lede">Everything on this computer stays free. Pro adds your other devices.</p>
      <div className="cw-plans cw-stagger" role="radiogroup" aria-label="Plan" data-testid="cw-plans">
        {rows.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={choice === r.id} className="cw-plan" data-testid={`cw-plan-${r.id}`}
            onClick={() => setChoice(r.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const i = rows.findIndex((x) => x.id === choice);
              const next = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]!;
              setChoice(next.id);
              (e.currentTarget.parentElement?.querySelector(`[data-testid="cw-plan-${next.id}"]`) as HTMLElement | null)?.focus();
            }}
            tabIndex={choice === r.id ? 0 : -1}>
            <span className="cw-tick" aria-hidden="true">{choice === r.id && <TickGlyph />}</span>
            <span className="min-w-0 flex-1 text-left">
              <span className="cw-plan-name">{r.name}</span>
              <span className="cw-plan-detail">{r.detail}</span>
            </span>
            <span className="cw-plan-price">{r.price}</span>
          </button>
        ))}
      </div>
      <button className="btn btn-primary mt-(--q-group) w-full" disabled={choice === 'pro' && !pro} onClick={go} data-testid="cw-plan-continue">
        {choice === 'free' ? 'Continue with Free' : choice === 'pro' ? 'Continue with Pro' : 'Email us'}
      </button>
    </>
  );
}

function formatFree(pro: BillingPlan | null) {
  const currency = (pro?.currency ?? 'usd').toUpperCase();
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(0);
}

/**
 * The test checkout: the Stripe test card on a card that tips into place and
 * types its number in, Pay, a short wait, paid. There are no card fields, so
 * nobody can type a real card into a page that charges nothing, and nothing
 * leaves this computer: the account's plan does not change.
 */
export function TestCheckout({ plan, email, onPaid, onState }: { plan: BillingPlan; email: string; onPaid: () => void; onState?: (s: 'ready' | 'paying' | 'paid') => void }) {
  const [state, setState] = useState<'ready' | 'paying' | 'paid'>('ready');
  useEffect(() => { onState?.(state); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const amount = price(plan).replace(/ a \w+$/, '');

  useEffect(() => {
    if (state !== 'paying') return;
    const t = setTimeout(() => setState('paid'), TEST_PAY_MS);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div className="pt-(--q-group)" data-testid="cw-checkout" data-state={state}>
      <div className="cw-card-wrap">
        <div className={`cw-card${state === 'paying' ? ' is-paying' : ''}${state === 'paid' ? ' is-paid' : ''}`} aria-label="Test card ending in 4242" role="img">
          <div className="cw-card-top"><span>Test card</span><span>Nekko Cloud Pro</span></div>
          <div className="cw-card-chip" />
          <TypedNumber text="4242 4242 4242 4242" />
          <div className="cw-card-bottom"><span className="truncate">{email}</span><span>12/34</span></div>
          {state === 'paid' && (
            <div className="cw-card-done">
              <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12.5 20.5l5 5 10-11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
          )}
        </div>
      </div>
      {state === 'paid' ? (
        <div className="cw-body-in">
          <h1 id="cw-title" className="mt-(--q-group)">You're on Pro</h1>
          <p className="cloud-lede text-info-text!" data-testid="cw-test-note">Test mode: nothing was charged and your account's plan hasn't changed.</p>
          <button className="btn btn-primary mt-(--q-group) w-full" onClick={onPaid} data-testid="cw-paid-continue">Continue</button>
        </div>
      ) : (
        <>
          <h1 id="cw-title" className="sr-only">Pay for Nekko Cloud Pro</h1>
          <div className="mt-(--q-group) flex justify-between text-sm"><span>Nekko Cloud Pro</span><span className="tabular-nums">{price(plan)}</span></div>
          <p className="cw-test-chip mt-(--q-tight)">Test mode: nothing is charged</p>
          <button className="btn btn-primary mt-(--q-group) w-full" disabled={state === 'paying'} onClick={() => setState('paying')} data-testid="cw-pay">
            {state === 'paying' ? <><span className="cw-spin" aria-hidden="true" />Paying…</> : `Pay ${amount}`}
          </button>
        </>
      )}
    </div>
  );
}

/** The card number types itself in, 28ms a character; at once with reduced motion. */
function TypedNumber({ text }: { text: string }) {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (n >= text.length) return;
    const t = setTimeout(() => setN((x) => x + 1), n === 0 ? 550 : 28);
    return () => clearTimeout(t);
  }, [n, text.length]);
  return (
    <div className="cw-card-num" aria-hidden="true">
      {text.slice(0, n)}<span className="cw-card-num-rest">{text.slice(n)}</span>
    </div>
  );
}

export function TickGlyph() {
  return <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
