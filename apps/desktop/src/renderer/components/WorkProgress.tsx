import React, { useEffect, useState } from 'react';
import type { PlanStep, PrInfo } from '@nekko-agent/shared';

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
const VERIFICATION_LABEL = { pending: 'Pending', active: 'Working', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', unknown: 'Unknown' };
const SYMBOL = { pending: '○', active: '◉', passed: '✓', failed: '✕', blocked: '⊘', unknown: '?' };

/** Only explicit agent reports count. Browser/screenshot tool success proves nothing here. */
export function VerificationChecklist({ steps = [] }: { steps?: PlanStep[] }) {
  const now = useProgressClock();
  const checks = steps.filter((step) => step.verification);
  if (!steps.length) return null;
  const passed = checks.filter((step) => step.verification?.status === 'passed').length;
  const blocked = checks.filter((step) => step.verification?.status === 'blocked').length;
  const failed = checks.filter((step) => step.verification?.status === 'failed').length;
  const waiting = checks.filter((step) => ['active', 'pending'].includes(step.verification!.status));
  const updatedAt = checks.length ? Math.max(...checks.map((step) => step.updatedAt)) : undefined;
  return <details open className="shrink-0 rounded-lg border border-line px-3 py-2 text-[11px]" data-verification-checklist>
    <summary className="cursor-pointer text-ink-soft">
      <span className="font-semibold">Verification</span>{' · '}
      <span>{checks.length ? `${passed} of ${checks.length} passed` : 'Unknown: no checklist published'}</span>
      {!!blocked && <span className="text-warning"> · {blocked} blocked</span>}
      {!!failed && <span className="text-danger"> · {failed} failed</span>}
      {checks.length > 0 && <span className="text-ink-faint"> · {progressAge(updatedAt, now, waiting.length > 0)}</span>}
    </summary>
    <div className="mt-2 max-h-40 space-y-2 overflow-y-auto" aria-label="Verification checklist">
      {!checks.length && <p className="text-ink-faint">No verification result reported. Tool completion is not visual inspection.</p>}
      {checks.map((step, index) => {
        const verification = step.verification!;
        const status = VERIFICATION_LABEL[verification.status] ?? 'Unknown';
        return <div key={step.id} className="flex items-start gap-2">
          <span aria-label={status} className={verification.status === 'passed' ? 'text-success' : verification.status === 'failed' ? 'text-danger' : 'text-ink-faint'}>{SYMBOL[verification.status] ?? '?'}</span>
          <div className="min-w-0 flex-1 break-words">
            <p className="text-ink-soft">{index + 1}. {step.title} <span className="text-ink-faint">· {status}</span></p>
            {verification.device && <p className="text-ink-faint">On {verification.device}</p>}
            {(verification.detail || step.note) && <p className="text-ink-soft">{verification.detail || step.note}</p>}
            <p className="text-ink-faint">{progressAge(step.updatedAt, now, ['active', 'pending'].includes(verification.status))}{safeProgressLink(verification.evidenceUrl) && <> · <ProgressLink url={verification.evidenceUrl}>Evidence</ProgressLink></>}</p>
          </div>
        </div>;
      })}
      <p className="text-[10px] text-ink-faint">Agent-reported inspection, not inferred from tool completion. Stale marks active or pending reports without recent updates, not necessarily stuck.</p>
    </div>
  </details>;
}

/** Uses the existing PR poller and its cached complete connections, never review totals as thread counts. */
export function PrProgress({ url, info }: { url: string; info?: PrInfo }) {
  const now = useProgressClock();
  const checks = info?.checkProgress;
  const threads = info?.reviewThreads;
  // Construct GitHub destinations rather than appending paths to an untrusted URL.
  let canonical: string | undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(parsed.pathname)) canonical = parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch { /* Unknown destination stays plain text. */ }
  return <div className="mt-1 space-y-1 break-words text-[10px] text-ink-soft" data-pr-progress>
    <p><ProgressLink url={canonical && canonical + '/checks'}>CI checks</ProgressLink>: {checks ? checks.total ? `${checks.completed + checks.failing} of ${checks.total} finished · ${checks.completed} passed/neutral/skipped · ${checks.pending} pending · ${checks.failing} failing${checks.unknown ? ` · ${checks.unknown} unknown` : ''}` : 'None reported' : 'Unknown: checks unavailable'}</p>
    {!!checks?.items.length && <details><summary className="cursor-pointer">Check details</summary><ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">{checks.items.map((check, index) => <li key={index}><ProgressLink url={check.link}>{check.name}</ProgressLink> · {check.state}</li>)}</ul></details>}
    <p><ProgressLink url={canonical && canonical + '/files'}>Review threads</ProgressLink>: {threads ? `${threads.resolved} resolved · ${threads.unresolved} unresolved` : 'Unknown: resolution counts unavailable'}</p>
    <p className="text-ink-faint">{info?.checkedAt ? `Checked ${progressAge(info.checkedAt, now)}` : 'Unknown: not fetched yet'}{threads ? ' · Counts are threads, not individual comments' : ''}</p>
  </div>;
}
