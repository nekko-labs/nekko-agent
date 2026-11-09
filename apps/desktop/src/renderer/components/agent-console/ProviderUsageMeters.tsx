import React from 'react';
import type { SubscriptionLimits } from '@nekko-agent/shared';

/** Account-scoped snapshots from the existing limits service; never inferred quota. */
export function ProviderUsageMeters({ limits, answered, now = Date.now(), compact = false }: { limits?: SubscriptionLimits; answered: boolean; now?: number; compact?: boolean }) {
  const windows = limits?.windows.filter(w => Number.isFinite(w.usedPercent)) ?? [];
  // Compact (the model picker): side by side on one line, and nothing at all
  // when the account reports no limits; a sentence saying so is noise there.
  if (!windows.length) return compact ? null : <p className="px-3 pb-2 text-2xs text-ink-faint">{answered ? 'Usage limits not reported' : 'Reading usage limits…'}</p>;
  const stale = !!limits && now > limits.updatedAt + limits.staleAfterMs;
  if (compact) {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 pb-2 pt-1" data-provider-usage>
        {windows.map(w => {
          const percent = Math.max(0, Math.min(100, w.usedPercent));
          const tone = w.status === 'rate_limited' ? 'danger' : w.status === 'warning' ? 'warning' : 'success';
          const reset = Number.isFinite(w.resetAt) && w.resetAt > now ? `Resets ${new Date(w.resetAt).toLocaleString()}` : 'Reset time not available';
          return (
            <div key={w.id} className="min-w-24 flex-1" title={`${w.label}: ${Math.round(w.usedPercent)}% used. ${reset}${stale ? '. Snapshot is stale' : ''}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-2xs">
                <span className="min-w-0 truncate text-ink-faint">{w.label}</span>
                <span className="shrink-0 tabular-nums" style={{ color: tone === 'success' ? 'var(--ink-faint)' : `var(--${tone})` }}>{Math.round(w.usedPercent)}% used</span>
              </div>
              <div role="meter" aria-label={`${w.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${Math.round(w.usedPercent)}% used${stale ? ', stale' : ''}`} className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${percent}%`, background: `var(--${tone})` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 px-3 pb-3" data-provider-usage>
      {stale && <p className="text-2xs text-ink-faint">Last reported usage · stale</p>}
      {windows.map(w => {
        const percent = Math.max(0, Math.min(100, w.usedPercent));
        const tone = w.status === 'rate_limited' ? 'danger' : w.status === 'warning' ? 'warning' : 'success';
        const status = w.status === 'rate_limited' ? ' · Limited' : w.status === 'warning' ? ' · Warning' : '';
        const reset = Number.isFinite(w.resetAt) && w.resetAt > now ? `Resets ${new Date(w.resetAt).toLocaleString()}` : 'Reset time not available';
        return (
          <div key={w.id} title={`${w.label}: ${Math.round(w.usedPercent)}% used${status}. ${reset}${stale ? '. Snapshot is stale' : ''}`}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-2xs">
              <span className="min-w-0 truncate text-ink-soft">{w.label}{status}</span>
              <span className="shrink-0 tabular-nums text-ink-faint">{Math.round(w.usedPercent)}% used</span>
            </div>
            <div role="meter" aria-label={`${w.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${Math.round(w.usedPercent)}% used${status}${stale ? ', stale' : ''}`} className="h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${percent}%`, background: `var(--${tone})` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
