import React, { useEffect, useState } from 'react';
import { parsePrUrl, type IssueInfo, type PrInfo } from '@nekko-agent/shared';
import { PR_STATUS_LABEL as STATUS_LABEL, PrStatusIcon, prStatus, prTone } from './SessionPrChip.js';

export { prStatus };

/** How long a looked-up PR state is trusted before a chip asks again. */
const FRESH_MS = 60_000;

type Info = PrInfo | IssueInfo;
type Entry = { info: Info | null; at: number };
const known = new Map<string, Entry>();
const inflight = new Map<string, Promise<Info | null>>();
const listeners = new Map<string, Set<(info: Info | null) => void>>();

/** One shared lookup per PR or issue, however many chips name it. */
function lookup(url: string, read: ((url: string) => Promise<Info | null>) | undefined): void {
  const hit = known.get(url);
  if ((hit && Date.now() - hit.at < FRESH_MS) || inflight.has(url) || !read) return;
  const pending = read(url).catch(() => hit?.info ?? null);
  inflight.set(url, pending);
  void pending.then((info) => {
    inflight.delete(url);
    known.set(url, { info, at: Date.now() });
    listeners.get(url)?.forEach((notify) => notify(info));
  });
}

function useInfo(url: string, read: () => ((url: string) => Promise<Info | null>) | undefined): Info | null {
  const [info, setInfo] = useState<Info | null>(() => known.get(url)?.info ?? null);
  useEffect(() => {
    let set = listeners.get(url);
    if (!set) listeners.set(url, (set = new Set()));
    set.add(setInfo);
    lookup(url, read());
    return () => { set.delete(setInfo); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return info;
}

export function usePrInfo(url: string): PrInfo | null {
  return useInfo(url, () => window.nekko?.getPrInfo) as PrInfo | null;
}

/** A GitHub issue's live state; null for any other task link, or until it is read. */
export function useIssueInfo(url: string): IssueInfo | null {
  const info = useInfo(url, () => window.nekko?.getIssueInfo);
  return info && 'kind' in info && info.kind === 'issue' ? info : null;
}

/** Test seam: forget every looked-up state. */
export function resetPrInfoCache(): void {
  known.clear();
  inflight.clear();
}

export function isPrUrl(href: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?(?:[?#].*)?$/i.test(href) && parsePrUrl(href) !== null;
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
