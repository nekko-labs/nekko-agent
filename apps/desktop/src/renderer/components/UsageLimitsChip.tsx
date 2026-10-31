import React, { useEffect, useState } from 'react';
import type { LimitWindow, ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { formatUSD, isLocalProvider } from '@nekko-agent/shared';
import { afterPaint } from '../afterPaint.js';

/** Relative time from now to a future timestamp, in compact words. */
function timeUntil(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} hr${h === 1 ? '' : 's'} ${m % 60 ? `${m % 60} min` : ''}`.trim();
  const d = Math.floor(h / 24);
  if (d < 30) return `in ${d} day${d === 1 ? '' : 's'}`;
  const mo = Math.floor(d / 30);
  return `in ${mo} month${mo === 1 ? '' : 's'}`;
}

function resetTime(resetAt: number, now: number): string {
  const relative = timeUntil(resetAt - now);
  if (!Number.isFinite(resetAt) || resetAt <= now) return 'resets soon';
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(resetAt));
  return `${relative} on ${date}`;
}

function relTime(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

/**
 * Chat-header usage chip:
 * - subscription providers: the binding (highest-utilization) window percent + reset countdown
 * - metered providers: the running session cost
 * - local models: Free
 *
 * Hover/focus opens a popover with every window, reset time, plan type and credits.
 */
export function UsageLimitsChip({
  provider,
  session,
  cost = 0,
  avoidedCosts,
  turnCost = 0,
  running = false,
  unpriced = false,
}: {
  provider?: ProviderConfig;
  session?: { id?: string } | null;
  cost?: number;
  avoidedCosts?: import('@nekko-agent/shared').AvoidedCosts;
  /**
   * What the reply now running has cost so far, accumulated live from the
   * turn's usage events. Zero between turns.
   */
  turnCost?: number;
  /** A reply is in flight, so the live figure is the one worth showing. */
  running?: boolean;
  /** Some cloud usage has no published API price; never present it as free. */
  unpriced?: boolean;
}) {
  const [limits, setLimits] = useState<SubscriptionLimits | null>(null);
  const [now, setNow] = useState(Date.now());

  // Refresh the countdowns every 30 seconds.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Load + subscribe to limits for this provider's token key.
  useEffect(() => {
    const tokenKey = provider?.tokenKey;
    if (!tokenKey) {
      setLimits(null);
      return;
    }
    let live = true;
    // Started after the first frame: a pane that just opened paints before it asks.
    const cancel = afterPaint(() => {
      window.nekko.getLimits(tokenKey).then((l) => { if (live) setLimits(l ?? null); }).catch(() => {});
    });
    const off = window.nekko.onLimitsUpdated((e) => {
      if (e.tokenKey === tokenKey) setLimits(e.limits);
    });
    return () => { live = false; cancel(); off(); };
  }, [provider?.tokenKey]);

  if (!provider) return null;

  const local = isLocalProvider(provider.kind);
  const subscription = provider.auth === 'subscription';

  // Binding window: the highest-utilization window is what the user is most likely to hit next.
  const windows = limits?.windows ?? [];
  const binding = windows.length
    ? [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
    : undefined;

  const stale = limits && now > limits.updatedAt + limits.staleAfterMs;

  /**
   * The running reply's cost, shown while it runs, for every provider.
   *
   * This is the number people actually want mid-turn ("what is this prompt
   * costing me"), and it was the one thing the chip could not say: it read the
   * usage log, which only moves once a turn has finished. A subscription turn
   * gets the same figure, labelled as what the plan absorbed rather than as a
   * bill, because "included" with no number tells you nothing about how hard
   * you just leaned on your quota.
   */
  const liveTurn = running && turnCost > 0;

  /**
   * Always a price: the chat's cost at the model's published API rates, or
   * Free for a local model. A subscription chat is priced the same way, so
   * "what is this costing" has one answer whoever pays it; the plan's limit
   * windows are in the popover.
   */
  const chipText = () => {
    if (local) return 'Free';
    const estimate = unpriced && cost + turnCost === 0
      ? 'No estimate'
      : `${formatUSD(cost + (liveTurn ? turnCost : 0))}${unpriced ? '+' : ''}`;
    return subscription ? `Subscription (${estimate})` : estimate;
  };

  const chipColor = () => {
    if (local) return 'var(--success)';
    if (subscription && binding) {
      if (binding.status === 'rate_limited') return 'var(--danger)';
      if (binding.status === 'warning') return 'var(--warning)';
    }
    return undefined;
  };

  const chipTitle = () => {
    if (local) return 'Local models run on this machine and cost nothing';
    const limit = subscription && binding
      ? ` · ${binding.label} window ${Math.round(binding.usedPercent)}% used, resets ${resetTime(binding.resetAt, now)}`
      : '';
    if (unpriced) return 'API-equivalent estimate is incomplete: some usage has no published price. Subscription usage is still included in your plan.';
    return subscription
      ? `This chat at the model's API list prices; your plan covers it${limit}`
      : 'Estimated chat cost at published list prices; your bill may differ';
  };

  const windowOrder: LimitWindow['scope'][] = ['session', 'weekly', 'model'];
  const sortedWindows = [...windows].sort(
    (a, b) => windowOrder.indexOf(a.scope) - windowOrder.indexOf(b.scope) || b.usedPercent - a.usedPercent,
  );

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        className="chip max-w-[180px] cursor-default"
        tabIndex={0}
        title={chipTitle()}
        style={chipColor() ? { color: chipColor(), background: `color-mix(in srgb, ${chipColor()} 14%, var(--surface-2))` } : undefined}
      >
        {chipText()}
      </button>

      {/* Hover/focus popover: every window, plus plan + credits. */}
      <div
        className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line p-3 text-2xs shadow-(--shadow-float) group-hover:block group-focus-within:block"
        style={{ background: 'var(--surface)' }}
        role="tooltip"
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-semibold text-ink">
            {subscription ? 'Subscription limits' : 'Session cost'}
          </span>
          {limits && (
            <span className="text-2xs text-ink-faint" title={stale ? 'Snapshot is stale; a new read will retry on the next update' : undefined}>
              {stale ? 'stale · ' : ''}updated {relTime(now - limits.updatedAt)}
            </span>
          )}
        </div>

        {liveTurn && (
          <div className="mb-2 flex items-baseline justify-between border-b border-line pb-2">
            <span className="text-ink-soft">This reply, so far</span>
            <span className="text-sm font-semibold tabular-nums text-accent">{formatUSD(turnCost)}</span>
          </div>
        )}

        {unpriced && <p className="mb-2 text-ink-faint">API-equivalent estimate unavailable for some usage. Unpriced tokens are excluded, not free.</p>}
        {avoidedCosts && (
          <div className="mb-2 space-y-1 border-b border-line pb-2">
            <div className="font-medium text-ink">Estimated API costs avoided · session</div>
            <div className="flex justify-between"><span>Subscription</span><span>{formatUSD(avoidedCosts.subscription)}</span></div>
            <div className="flex justify-between"><span>Local AI</span><span>{formatUSD(avoidedCosts.local)}</span></div>
            <p className="text-ink-faint">Cloud equivalents; excludes plan fees, hardware and electricity.</p>
            {avoidedCosts.benchmarkTokens > 0 && <p className="text-ink-faint">Local estimate includes your configured cloud benchmark.</p>}
            {avoidedCosts.unpricedTokens > 0 && <p className="text-ink-faint">{avoidedCosts.unpricedTokens.toLocaleString()} unpriced tokens excluded.</p>}
          </div>
        )}
        {subscription ? (
          <>
            <div className="mb-2 flex items-baseline justify-between border-b border-line pb-2">
              <span className="text-ink-soft">This chat at API prices</span>
              <span className="text-sm font-semibold tabular-nums">{unpriced && cost + turnCost === 0 ? 'Unavailable' : `${formatUSD(cost + (liveTurn ? turnCost : 0))}${unpriced ? '+' : ''}`}</span>
            </div>
            {sortedWindows.length === 0 ? (
              <p className="text-ink-faint">No limit windows reported yet. Send a message to refresh.</p>
            ) : (
              <div className="space-y-1">
                {sortedWindows.map((w) => {
                  const tone = w.status === 'rate_limited' ? 'danger' : w.status === 'warning' ? 'warning' : 'success';
                  const statusLabel = w.status === 'rate_limited' ? 'Limited' : w.status === 'warning' ? 'Warning' : 'OK';
                  return (
                    <div key={w.id} className="grid grid-cols-[8px_minmax(0,1fr)_36px_auto] items-center gap-2" title={`Resets ${resetTime(w.resetAt, now)} (local time)`}>
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: `var(--${tone})` }}
                        title={statusLabel}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-soft">{w.label}</span>
                      <span className="shrink-0 tabular-nums font-medium">{Math.round(w.usedPercent)}%</span>
                      <span className="whitespace-nowrap text-right tabular-nums text-ink-faint">
                        {w.resetAt > now ? timeUntil(w.resetAt - now) : 'resets soon'}
                      </span>
                    </div>
                  );
                })}
                {binding && <p className="pt-1 text-ink-faint">Resets {resetTime(binding.resetAt, now)} (local time)</p>}
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-2xs text-ink-faint">
              <span>Plan: {limits?.planType ?? 'not reported'}</span>
              <span>Credits: {creditsLabel(limits)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-ink-soft">This session</span>
              {/* Only while the reply is running. Once it finishes, the usage
                  log absorbs it into `cost`, and adding it again here would
                  count the same turn twice until the next send. */}
              <span className="text-sm font-semibold tabular-nums">
                {formatUSD(cost + (liveTurn ? turnCost : 0))}
              </span>
            </div>
            <p className="mt-1 text-ink-faint">
              {local
                ? 'Local models run privately on this machine and cost nothing.'
                : 'Estimate from published list prices. Your provider bill may differ.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the credit figure means, said plainly.
 *
 * A missing balance used to render as "Unlimited", which answered a question
 * the provider had never been asked: a plan with extra usage switched off and a
 * plan we simply had not read yet both looked unlimited. Each state now says
 * which one it is.
 */
function creditsLabel(limits: SubscriptionLimits | null): string {
  if (!limits) return 'not read yet';
  switch (limits.creditsState) {
    case 'balance':
      return limits.creditsBalance === undefined ? 'not reported' : formatUSD(limits.creditsBalance);
    case 'unlimited':
      return 'Unlimited';
    case 'disabled':
      return 'Extra usage off';
    default:
      // A snapshot from before this field existed, or a provider that reports
      // no credit information at all.
      return limits.creditsBalance === undefined ? 'not reported' : formatUSD(limits.creditsBalance);
  }
}
