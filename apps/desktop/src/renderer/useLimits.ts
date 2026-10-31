import { useEffect, useState, useCallback } from 'react';
import type { LimitsProblem, ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { limitsKeyFor } from '@nekko-agent/shared';
import { useStore } from './store.js';
import { useRunningSessionsSnapshot } from './liveRuns.js';
import { limitsRefreshInterval, nextLimitsRefresh } from './limitsSchedule.js';

const lastRead = new Map<string, number>();
const pendingReads = new Map<string, Promise<SubscriptionLimits | undefined>>();
function readLimits(key: string, force = false): Promise<SubscriptionLimits | undefined> {
  const pending = pendingReads.get(key);
  if (pending) return pending;
  lastRead.set(key, Date.now());
  const promise = window.nekko.getLimits(key, force).finally(() => pendingReads.delete(key));
  pendingReads.set(key, promise);
  return promise;
}

/**
 * Live subscription limits for one provider, or null when it doesn't have any
 * (a provider without a usage read, a local server, or one that isn't signed
 * in).
 *
 * Read in several places at once — the composer's model picker, the Auto-mode
 * pick, the workbench sidebar — so it loads once and then follows the host's
 * `limitsUpdated` events rather than each caller polling on its own.
 */
export function useProviderLimits(provider: ProviderConfig | undefined): SubscriptionLimits | null {
  const { byToken } = useProviderLimitsPortfolio(provider ? [provider] : []);
  const key = provider ? limitsKeyFor(provider) : null;
  return key ? byToken[key] ?? null : null;
}

/**
 * Limits for several providers at once, keyed by token key. Used by the model
 * picker, whose list spans every configured provider rather than just the one
 * this chat is on.
 */
export function useAllProviderLimits(
  providers: ProviderConfig[],
  enabled = true,
): Record<string, SubscriptionLimits> {
  return useProviderLimitsPortfolio(providers, enabled).byToken;
}

/**
 * The same read, plus which token keys have answered at all.
 *
 * A provider that answers "no limits" and one whose answer has not arrived yet
 * both leave `byToken` without an entry, and a panel that lists every provider
 * has to tell them apart or it says "reading…" forever about the first kind.
 */
export function useProviderLimitsPortfolio(
  providers: ProviderConfig[],
  enabled = true,
): { byToken: Record<string, SubscriptionLimits>; answered: ReadonlySet<string>; problems: Record<string, LimitsProblem>; refresh: () => Promise<void>; nextRefreshAt: number | null } {
  const [byToken, setByToken] = useState<Record<string, SubscriptionLimits>>({});
  // Why a key answered with nothing, from the host. Only asked for after an
  // empty answer, so a healthy panel costs no extra round trip.
  const [problems, setProblems] = useState<Record<string, LimitsProblem>>({});
  const noteProblem = (key: string, limits: SubscriptionLimits | undefined | null) => {
    if (limits) { setProblems((prev) => { if (!(key in prev)) return prev; const next = { ...prev }; delete next[key]; return next; }); return; }
    void window.nekko.getLimitsProblem?.(key).then((problem) => setProblems((prev) => {
      if (!problem) { if (!(key in prev)) return prev; const next = { ...prev }; delete next[key]; return next; }
      return { ...prev, [key]: problem };
    })).catch(() => {});
  };
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Limits keys, as a stable string, so re-rendering with a new array identity
  // doesn't re-fetch every provider's usage. Covers signed-in providers by
  // token key and API-key providers with a documented read by provider id.
  const keys = providers.map(limitsKeyFor).filter((k): k is string => !!k);
  const keysId = keys.join('|');
  const sessions = useStore((s) => s.sessions);
  const configured = useStore((s) => s.providers);
  const running = new Set<string>(JSON.parse(useRunningSessionsSnapshot()));
  const activeKeys = new Set((sessions ?? []).filter(s => running.has(s.id)).flatMap(s => {
    const provider = (configured ?? []).find(p => p.id === s.providerId && (p.auth === 'subscription' || p.kind === 'claude-code'));
    const key = provider && limitsKeyFor(provider);
    return key ? [key] : [];
  }));
  const activeId = [...activeKeys].sort().join('|');
  const [clock, setClock] = useState(Date.now);
  const nextRefreshAt = enabled ? nextLimitsRefresh(keys, lastRead, activeKeys, clock) : null;

  useEffect(() => {
    if (!enabled || keys.length === 0) return;
    let live = true;
    Promise.all(
      keys.map((k) => readLimits(k).then((l) => [k, l] as const).catch(() => [k, null] as const)),
    ).then((entries) => {
      if (!live) return;
      const next: Record<string, SubscriptionLimits> = {};
      for (const [k, l] of entries) if (l) next[k] = l;
      setByToken(next);
      setAnswered(new Set(entries.map(([k]) => k)));
      for (const [k, l] of entries) noteProblem(k, l);
    });
    const off = window.nekko.onLimitsUpdated((e) => {
      if (keys.includes(e.tokenKey)) setByToken((prev) => ({ ...prev, [e.tokenKey]: e.limits }));
    });
    return () => { live = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, keysId]);

  useEffect(() => {
    if (!enabled || keys.length === 0) return;
    let live = true;
    const timer = setInterval(() => {
      const now = Date.now();
      setClock(now);
      for (const key of new Set(keys)) {
        if (pendingReads.has(key) || now < (lastRead.get(key) ?? now) + limitsRefreshInterval(activeKeys.has(key))) continue;
        void readLimits(key, true).then(limits => {
          if (!live) return;
          setAnswered(prev => new Set([...prev, key]));
          noteProblem(key, limits);
          setByToken(prev => {
            const next = { ...prev };
            if (limits) next[key] = limits;
            else delete next[key];
            return next;
          });
        }).catch(() => {});
      }
    }, 1000);
    return () => { live = false; clearInterval(timer); };
    // Stable key sets prevent restarting the clock on streamed tokens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, keysId, activeId]);

  const refresh = useCallback(async () => {
    const entries = await Promise.all([...new Set(keys)].map(async key => [key, await readLimits(key, true)] as const));
    setByToken(Object.fromEntries(entries.filter((entry): entry is readonly [string, SubscriptionLimits] => !!entry[1])));
    setAnswered(new Set(entries.map(([key]) => key)));
    for (const [key, limits] of entries) noteProblem(key, limits);
  }, [keysId]);
  return { byToken, answered, problems, refresh, nextRefreshAt };
}
