import React, { useEffect, useState } from 'react';
import type { PrInfo } from '@nekko-agent/shared';

/** Freshness is a report age, not an inference that work stopped or passed. */
export const PROGRESS_STALE_MS = 120_000;
export function progressAge(at: number | undefined, now: number, canBeStale = true) {
  if (!at || !Number.isFinite(at) || at > now) return 'Unknown update time';
  const seconds = Math.floor((now - at) / 1000);
  return `${seconds >= 60 ? Math.floor(seconds / 60) + 'm' : seconds + 's'} ago${canBeStale && now - at >= PROGRESS_STALE_MS ? ' · Stale' : ''}`;
}
function useProgressClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  return now;
}
/** Defense in depth for persisted/older data as well as current engine responses. */
export function safeProgressLink(value: string | undefined | null): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
function ProgressLink({ url, children }: { url?: string | null; children: React.ReactNode }) {
  const safe = safeProgressLink(url);
  return safe ? <a className="underline decoration-dotted underline-offset-2 hover:text-ink" href={safe} onClick={(event) => { event.preventDefault(); void window.nekko.openPath(safe).catch(() => {}); }}>{children}</a> : <span>{children}</span>;
}

/** Construct GitHub destinations rather than appending paths to an untrusted URL. */
export function canonicalPrUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(parsed.pathname)) return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch { /* Unknown destination stays plain text. */ }
  return undefined;
}

/** Uses the existing PR poller and its cached complete connections, never review totals as thread counts. */
export function PrProgress({ url, info, checks: showChecks = true }: { url: string; info?: PrInfo; checks?: boolean }) {
  const now = useProgressClock();
  const checks = info?.checkProgress;
  const threads = info?.reviewThreads;
  const canonical = canonicalPrUrl(url);
  return <div className="mt-1 space-y-1 break-words text-2xs text-ink-soft" data-pr-progress>
    {showChecks && <><p><ProgressLink url={canonical && canonical + '/checks'}>CI checks</ProgressLink>: {checks ? checks.total ? `${checks.completed + checks.failing} of ${checks.total} finished · ${checks.completed} passed/neutral/skipped · ${checks.pending} pending · ${checks.failing} failing${checks.unknown ? ` · ${checks.unknown} unknown` : ''}` : 'None reported' : 'Unknown: checks unavailable'}</p>
    {!!checks?.items.length && <details><summary className="cursor-pointer">Check details</summary><ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">{checks.items.map((check, index) => <li key={index}><ProgressLink url={check.link}>{check.name}</ProgressLink> · {check.state}</li>)}</ul></details>}</>}
    <p><ProgressLink url={canonical && canonical + '/files'}>Review threads</ProgressLink>: {threads ? `${threads.resolved} resolved · ${threads.unresolved} unresolved` : 'Unknown: resolution counts unavailable'}</p>
    <p className="text-ink-faint">{info?.checkedAt ? `Checked ${progressAge(info.checkedAt, now)}` : 'Unknown: not fetched yet'}{threads ? ' · Counts are threads, not individual comments' : ''}</p>
  </div>;
}
