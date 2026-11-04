import React, { useEffect, useState } from 'react';
import { parsePrUrl, type PrInfo } from '@nekko-agent/shared';
import { prTone } from './SessionPrLinks.js';

/** How long a looked-up PR state is trusted before a chip asks again. */
const FRESH_MS = 60_000;

type Entry = { info: PrInfo | null; at: number };
const known = new Map<string, Entry>();
const inflight = new Map<string, Promise<PrInfo | null>>();
const listeners = new Map<string, Set<(info: PrInfo | null) => void>>();

/** One shared lookup per PR, however many chips in the transcript name it. */
function lookup(url: string): void {
  const hit = known.get(url);
  if ((hit && Date.now() - hit.at < FRESH_MS) || inflight.has(url) || !window.nekko?.getPrInfo) return;
  const read = window.nekko.getPrInfo(url).catch(() => hit?.info ?? null);
  inflight.set(url, read);
  void read.then((info) => {
    inflight.delete(url);
    known.set(url, { info, at: Date.now() });
    listeners.get(url)?.forEach((notify) => notify(info));
  });
}

export function usePrInfo(url: string): PrInfo | null {
  const [info, setInfo] = useState<PrInfo | null>(() => known.get(url)?.info ?? null);
  useEffect(() => {
    let set = listeners.get(url);
    if (!set) listeners.set(url, (set = new Set()));
    set.add(setInfo);
    lookup(url);
    return () => { set.delete(setInfo); };
  }, [url]);
  return info;
}

/** Test seam: forget every looked-up state. */
export function resetPrInfoCache(): void {
  known.clear();
  inflight.clear();
}

export function isPrUrl(href: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?(?:[?#].*)?$/i.test(href) && parsePrUrl(href) !== null;
}

type Status = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

export function prStatus(pr: PrInfo | null): Status {
  if (!pr) return 'unknown';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

const STATUS_LABEL: Record<Status, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', unknown: 'Pull request' };

/** GitHub's four PR glyphs, so the state reads at a glance before the colour does. */
function PrStatusIcon({ status }: { status: Status }) {
  const common = { className: 'h-3.5 w-3.5 shrink-0', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (status === 'merged') {
    return <svg {...common}><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="8" r="1.75" /><path d="M4.5 5.25v5.5M4.5 5.5c0 2.5 2 2.5 5.25 2.5" /></svg>;
  }
  if (status === 'closed') {
    return <svg {...common}><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5M11.5 6.5v4.25M9.75 2.25l3.5 3.5M13.25 2.25l-3.5 3.5" /></svg>;
  }
  if (status === 'draft') {
    return <svg {...common}><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5" /><path d="M11.5 3v.5M11.5 6.5v1M11.5 9.5v1" /></svg>;
  }
  return <svg {...common}><circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="12.5" r="1.75" /><path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.5" /><path d="m9 3-1.5 1.5L9 6" /></svg>;
}

/**
 * A GitHub PR link drawn as a compact chip: the PR's live state glyph, tinted
 * as on GitHub, and its label. Opens in the external browser like any link.
 */
export function PrLinkChip({ href, label, onContextMenu }: { href: string; label?: React.ReactNode; onContextMenu?: (e: React.MouseEvent) => void }) {
  const pr = usePrInfo(href);
  const status = prStatus(pr);
  const parsed = parsePrUrl(href);
  const fallback = parsed ? `${parsed.repo}#${parsed.number}` : href;
  const title = pr ? `${pr.owner}/${pr.repo}#${pr.number} · ${STATUS_LABEL[status]} · ${pr.title}` : `${fallback} · ${href}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-pr-status={status}
      title={title}
      className="pr-link-chip mx-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-line px-2 py-px align-[-0.15em] text-sm font-medium leading-5 no-underline hover:bg-surface-2 focus-visible:outline focus-visible:outline-accent"
      onContextMenu={onContextMenu}
    >
      <span style={{ color: pr ? prTone(pr) : 'var(--ink-faint)' }} className="inline-flex"><PrStatusIcon status={status} /></span>
      <span className="min-w-0 truncate text-ink">{label ?? fallback}</span>
      <span className="sr-only"> ({STATUS_LABEL[status]})</span>
    </a>
  );
}
