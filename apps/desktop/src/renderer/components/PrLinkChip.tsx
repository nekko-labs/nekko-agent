import React, { useEffect, useState } from 'react';
import { parsePrUrl, type IssueInfo, type PrInfo } from '@nekko-agent/shared';
import { PR_STATUS_LABEL as STATUS_LABEL, PrStatusIcon, prStatus, prTone } from './SessionPrChip.js';
import { LIVE_STATE_FRESH_MS, isLiveState, onLiveStateTick } from '../liveStateTicker.js';
import { GfIcon } from '../gentleface-icons.js';

export { prStatus };

/** How long a looked-up PR state is trusted before a chip asks again. */
const FRESH_MS = LIVE_STATE_FRESH_MS;
/**
 * A re-check reads anything older than this, so with one tick per FRESH_MS a
 * live chip is at most about a minute behind (plus the engine's own cache).
 */
const RECHECK_AFTER_MS = FRESH_MS / 2;

type Info = PrInfo | IssueInfo;
type Read = (url: string) => Promise<Info | null>;
type Entry = { info: Info | null; at: number };
const known = new Map<string, Entry>();
const inflight = new Map<string, Promise<Info | null>>();
const listeners = new Map<string, Set<(info: Info | null) => void>>();
const readers = new Map<string, Read>();
let stopTicker: (() => void) | null = null;

/** One shared lookup per PR or issue, however many chips name it. */
function lookup(url: string, read: Read | undefined, maxAge = FRESH_MS): void {
  const hit = known.get(url);
  if ((hit && Date.now() - hit.at < maxAge) || inflight.has(url) || !read) return;
  const pending = read(url).catch(() => hit?.info ?? null);
  inflight.set(url, pending);
  void pending.then((info) => {
    inflight.delete(url);
    known.set(url, { info, at: Date.now() });
    listeners.get(url)?.forEach((notify) => notify(info));
    syncTicker();
  });
}

/** URLs a mounted chip shows in a state that can still change. */
function watchedLive(): string[] {
  return [...listeners].flatMap(([url, set]) => set.size > 0 && isLiveState(known.get(url)?.info) ? [url] : []);
}

function recheck(): void {
  for (const url of watchedLive()) lookup(url, readers.get(url), RECHECK_AFTER_MS);
}

/** The shared ticker runs only while some mounted chip shows an open PR or issue. */
function syncTicker(): void {
  const watching = watchedLive().length > 0;
  if (watching && !stopTicker) stopTicker = onLiveStateTick(recheck);
  else if (!watching && stopTicker) { stopTicker(); stopTicker = null; }
}

/**
 * Watch one PR or issue: read it (shared with every other watcher of the URL),
 * then re-read it while it is open and someone is watching. Returns the stop.
 */
export function watchInfo(url: string, read: Read | undefined, notify: (info: Info | null) => void): () => void {
  let set = listeners.get(url);
  if (!set) listeners.set(url, (set = new Set()));
  set.add(notify);
  if (read) readers.set(url, read);
  lookup(url, read);
  syncTicker();
  return () => {
    set.delete(notify);
    if (set.size === 0 && listeners.get(url) === set) listeners.delete(url);
    syncTicker();
  };
}

function useInfo(url: string, read: () => Read | undefined): Info | null {
  const [info, setInfo] = useState<Info | null>(() => known.get(url)?.info ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => watchInfo(url, read(), setInfo), [url]);
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
  readers.clear();
  listeners.clear();
  stopTicker?.();
  stopTicker = null;
}

/** An issue's state as a glyph, tone and word: open, done, or not planned. */
export function issueLook(issue: IssueInfo) {
  if (issue.state === 'open') return { icon: 'record', tone: 'var(--success)', label: 'Open' } as const;
  if (issue.stateReason === 'not_planned') return { icon: 'ban', tone: 'var(--ink-faint)', label: 'Not planned' } as const;
  return { icon: 'check-circle', tone: 'var(--merged-ink)', label: 'Done' } as const;
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

/** A GitHub issue reference drawn like a PR chip, with the issue's live state. */
export function IssueLinkChip({ href, label }: { href: string; label: React.ReactNode }) {
  const issue = useIssueInfo(href);
  const look = issue && issueLook(issue);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-issue-state={look ? look.icon : 'unknown'}
      title={issue ? `${issue.owner}/${issue.repo}#${issue.number} · ${look!.label} · ${issue.title}` : href}
      className="pr-link-chip mx-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-line px-2 py-px align-[-0.15em] text-sm font-medium leading-5 no-underline hover:bg-surface-2 focus-visible:outline focus-visible:outline-accent"
    >
      <span style={{ color: look ? look.tone : 'var(--ink-faint)' }} className="inline-flex"><GfIcon name={look ? look.icon : 'record'} className="h-3.5 w-3.5" /></span>
      <span className="min-w-0 truncate text-ink">{label}</span>
      {look && <span className="sr-only"> ({look.label})</span>}
    </a>
  );
}
