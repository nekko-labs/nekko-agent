import { useEffect, useState } from 'react';
import { type BillingPlan, type TeamFeatureState, type TeamFeatures, cloudError } from '@nekko-agent/shared';
import { QuietTabs } from '../primitives/Quiet.js';

/**
 * Settings > Sync, under the account (#2724). Shown only when billing is
 * switched on for this account: Upgrade on Free, Manage billing on a paid
 * plan. Both open a Stripe page in the browser; the plan follows when the
 * window comes back.
 */
export function PlanRow({ plan }: { plan: string }) {
  const paid = plan === 'pro' || plan === 'team';
  const [pro, setPro] = useState<BillingPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (paid) return;
    let live = true;
    window.nekko.cloudBillingPlans()
      .then((r) => { if (live) setPro(r.plans.find((p) => p.id === 'pro') ?? null); })
      .catch((e) => { if (live) setError(cloudError(e)); });
    return () => { live = false; };
  }, [paid]);

  const open = async (get: () => Promise<{ url: string }>) => {
    setBusy(true);
    setError('');
    try {
      const { url } = await get();
      await window.nekko.openPath(url);
      window.addEventListener('focus', () => { void window.nekko.cloudRefresh().catch(() => {}); }, { once: true });
    } catch (e) {
      setError(cloudError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-row" data-testid="billing-plan">
      <div className="min-w-0 text-sm">
        {paid ? (
          <>
            <div className="font-medium text-ink">Billing</div>
            <div className="mt-(--q-tight) text-xs text-ink-faint">Change your card, see invoices or cancel, on Stripe.</div>
          </>
        ) : (
          <>
            <div className="font-medium text-ink">Nekko Cloud Pro{pro && <span className="ml-2 font-normal text-ink-soft" data-testid="billing-price">{price(pro)}</span>}</div>
            <div className="mt-(--q-tight) text-xs text-ink-faint">Synced chats, Nekko Cloud machines and organizations. For a team, email hello@nekkoagent.com.</div>
          </>
        )}
        {error && <p role="alert" className="mt-(--q-tight) text-xs text-danger-text">{error}</p>}
      </div>
      {paid ? (
        <button className="btn btn-ghost shrink-0 py-1! text-xs!" disabled={busy} onClick={() => void open(() => window.nekko.cloudBillingPortal())} data-testid="billing-manage">
          {busy ? 'Opening…' : 'Manage billing'}
        </button>
      ) : (
        <button className="btn btn-primary shrink-0 py-1! text-xs!" disabled={busy || !pro} onClick={() => void open(() => window.nekko.cloudBillingCheckout('pro'))} data-testid="billing-upgrade">
          {busy ? 'Opening…' : 'Upgrade'}
        </button>
      )}
    </div>
  );
}

const STATES: { value: TeamFeatureState; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'team', label: 'Team only' },
  { value: 'on', label: 'Everyone' },
];

/** Nekko team accounts only (decision 0092): switch unreleased Cloud features. */
export function TeamSwitches() {
  const [team, setTeam] = useState<TeamFeatures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    window.nekko.cloudTeamFeatures().then((t) => { if (live) setTeam(t); }).catch((e) => { if (live) setError(cloudError(e)); });
    return () => { live = false; };
  }, []);

  const set = async (state: TeamFeatureState) => {
    if (state === 'on' && !window.confirm('Show Upgrade and Manage billing to every Nekko Cloud account?')) return;
    setBusy(true);
    setError('');
    try {
      setTeam(await window.nekko.cloudSetTeamFeature('billing', state));
    } catch (e) {
      setError(cloudError(e));
    } finally {
      setBusy(false);
    }
  };

  const available = team?.available.includes('billing') ?? false;
  return (
    <div className="sync-row flex-wrap" data-testid="team-switches">
      <div className="min-w-0 text-sm">
        <div className="font-medium text-ink">Plans and billing <span className="ml-1 text-xs font-normal text-ink-faint">Nekko team</span></div>
        <div className="mt-(--q-tight) text-xs text-ink-faint">
          {team && !available ? 'Stripe isn\'t set up on Nekko Cloud yet, so this stays hidden whatever it\'s set to.' : 'Who sees Upgrade and Manage billing. Only the Nekko team sees this switch.'}
        </div>
        {error && <p role="alert" className="mt-(--q-tight) text-xs text-danger-text">{error}</p>}
      </div>
      <QuietTabs role="radiogroup" label="Who sees plans and billing" className="shrink-0"
        items={STATES.map((s) => ({ ...s, disabled: busy || !team }))}
        value={team?.features.billing ?? null} onChange={(s) => void set(s)} />
    </div>
  );
}

export function price(p: BillingPlan) {
  // Stripe counts in the currency's smallest unit: cents for USD, whole yen for JPY.
  const currency = p.currency.toUpperCase();
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = p.amount / 10 ** digits;
  const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: Number.isInteger(value) ? 0 : digits });
  return `${f.format(value)} a ${p.interval}`;
}
