import React, { useState } from 'react';
import type { LimitWindow, ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { formatUSD, isLocalProvider, limitsKeyFor } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { accountEmailOf, useAccountEmails } from '../accountEmails.js';
import { ChevronIcon } from '../icons.js';

/**
 * Capacity across every provider at once, above the resource meters.
 *
 * The usage chip in the chat header answers "how much of *this* provider have I
 * spent", which is the wrong question when the useful move is to send the next
 * job somewhere else. This panel answers the portfolio question instead: across
 * Claude, OpenAI, OpenRouter and anything else signed in, where is there room
 * left, and what is about to run out.
 *
 * It is deliberately read-only for now. Knowing where the capacity is comes
 * first; routing to it automatically is the follow-on, and is recorded as such
 * in TASKS.md rather than half-built here.
 */

const DOCK_OPEN_KEY = 'nekko.providerLimits.open';

/** The colour a window earns by how close it is to being spent. */
function toneFor(status: LimitWindow['status'], percent: number): string {
  if (status === 'rate_limited' || percent >= 100) return 'var(--danger)';
  if (status === 'warning' || percent >= 80) return 'var(--warning)';
  if (percent >= 50) return 'var(--info)';
  return 'var(--success)';
}

/** Compact "2d" / "3h" / "12m" until a reset, for a tight row. */
function untilShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The window that decides a provider's headroom: the one closest to spent.
 * That is the one that will stop the next job, whatever the others say.
 */
function bindingWindow(limits: SubscriptionLimits | undefined): LimitWindow | undefined {
  return [...(limits?.windows ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

export function ProviderLimitsDock({ standalone = false }: { standalone?: boolean } = {}) {
  const providers = useStore((s) => s.providers);
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      return standalone || window.localStorage.getItem(DOCK_OPEN_KEY) !== 'off';
    } catch {
      return true;
    }
  });

  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(DOCK_OPEN_KEY, next ? 'on' : 'off');
      } catch {
        /* private mode */
      }
      return next;
    });

  // Only providers that can report a quota at all. A local server has no limit
  // to show and an unconfigured one has nothing to ask.
  const metered = providers.filter((p) => p.enabled && !isLocalProvider(p.kind));
  const { byToken: limitsByToken, answered } = useProviderLimitsPortfolio(metered, open);
  const accountEmails = useAccountEmails(metered);

  // Fetching is keyed by limits key, so a provider without one can only be
  // listed as unsigned or unmeasurable rather than measured.
  const rows = metered.map((p) => {
    const key = limitsKeyFor(p);
    return {
      provider: p,
      limits: key ? limitsByToken[key] : undefined,
      answered: !!key && answered.has(key),
    };
  });

  if (rows.length === 0) return standalone ? <p className="p-4 text-sm text-ink-faint">No enabled subscription or API providers. Add a provider to see its usage limits.</p> : null;

  // The single most-spent window anywhere, which is the headline when collapsed.
  const worst = rows
    .map((r) => bindingWindow(r.limits))
    .filter((w): w is LimitWindow => !!w)
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];

  return (
    <div className={`shrink-0 border-t border-line px-4 text-2xs ${open ? 'py-4' : 'py-2'}`}>
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={toggle}
        aria-expanded={open}
        title={open ? 'Collapse provider capacity' : 'Show capacity across every provider'}
      >
        <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
          Capacity
          <span className="chip text-2xs">{rows.length}</span>
        </span>
        {/* Collapsed, the header still carries the number worth glancing at:
            whichever window across every provider is closest to stopping work. */}
        {!open && worst && (
          <span
            className="shrink-0 text-2xs tabular-nums"
            style={{ color: toneFor(worst.status, worst.usedPercent) }}
            title={`Most-used window anywhere: ${worst.label} at ${Math.round(worst.usedPercent)}%`}
          >
            peak {Math.round(worst.usedPercent)}%
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2">
          {rows.map(({ provider, limits, answered: settled }) => (
            <ProviderRow key={provider.id} provider={provider} email={accountEmailOf(provider, accountEmails)} limits={limits} answered={settled} />
          ))}
          <p className="pt-0.5 text-2xs leading-snug text-ink-faint">
            Live reads from each provider's documented usage endpoint, not a bill. Providers
            without one say so instead of guessing.
          </p>
        </div>
      )}
    </div>
  );
}

/** One provider: its headline number, then a bar per window it reports. */
function ProviderRow({
  provider,
  email,
  limits,
  answered,
}: {
  provider: ProviderConfig;
  /** The account this provider is signed in as, when known. */
  email?: string;
  limits: SubscriptionLimits | undefined;
  /** The provider has replied, even if the reply was "no limits". */
  answered: boolean;
}) {
  const now = Date.now();
  const subscription = provider.auth === 'subscription';
  const binding = bindingWindow(limits);
  const windows = limits?.windows ?? [];

  /**
   * What this provider says about itself, in one line.
   *
   * Every state here is a different answer and they used to be easy to confuse:
   * a provider that is not signed in, one that has not answered yet, and one
   * that genuinely publishes no quota all look like "no data" unless each says
   * which it is.
   */
  const status = (): { text: string; tone?: string } => {
    // A Claude Agent's plan usage lives in Claude Code; Nekko shows none (claude-policy.ts).
    if (provider.kind === 'claude-code') return { text: 'usage shown in Claude Code' };
    if (subscription && !provider.tokenKey) return { text: 'not signed in' };
    if (!limits) {
      if (!subscription) {
        // A provider with a documented read gets asked; one without gets an
        // honest "no usage API" rather than a label that implies data.
        if (!limitsKeyFor(provider)) return { text: 'no usage API' };
        return { text: answered ? 'no quota reported' : 'reading…' };
      }
      return { text: answered ? 'no quota reported' : 'reading…' };
    }
    if (!binding) return { text: 'no quota reported' };
    return {
      text: `${Math.round(binding.usedPercent)}% used`,
      tone: toneFor(binding.status, binding.usedPercent),
    };
  };
  const s = status();

  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-ink-soft" title={email ? `${provider.label} · ${email}` : provider.label}>
          {provider.label}
          {email && <span className="font-normal text-ink-faint" data-account-email> · {email}</span>}
        </span>
        {limits?.creditsState === 'balance' && limits.creditsBalance !== undefined && (
          <span className="shrink-0 text-2xs tabular-nums text-ink-faint" title="Credit balance left">
            {formatUSD(limits.creditsBalance)}
          </span>
        )}
        <span className="shrink-0 text-2xs tabular-nums" style={s.tone ? { color: s.tone } : undefined}>
          {s.text}
        </span>
      </div>

      {windows.length > 0 && (
        <div className="mt-1 space-y-1">
          {windows.map((w) => {
            const tone = toneFor(w.status, w.usedPercent);
            return (
              <div key={w.id} className="flex items-center gap-1.5">
                <span className="w-20 shrink-0 truncate text-2xs text-ink-faint" title={w.label}>
                  {w.label}
                </span>
                <span
                  className="h-1 min-w-0 flex-1 overflow-hidden rounded-full"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.min(100, w.usedPercent)}%`, background: tone }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right text-2xs tabular-nums" style={{ color: tone }}>
                  {Math.round(w.usedPercent)}%
                </span>
                <span
                  className="w-6 shrink-0 text-right text-2xs tabular-nums text-ink-faint"
                  title={w.resetAt > now ? `Resets in ${untilShort(w.resetAt - now)}` : 'Resets soon'}
                >
                  {w.resetAt > now ? untilShort(w.resetAt - now) : '~'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
