import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrInfo } from '@nekko-agent/shared';

/**
 * The PR a chat is about, as a chip at the bottom right of its sidebar card:
 * GitHub's glyph for the PR's state, tinted as GitHub tints it, and `#123`.
 * When the chat has several PRs the chip shows the one that matters most (see
 * `primaryPr`) and a `+N` that lists every PR on hover (or click, for keyboard
 * and touch), each one its own link.
 *
 * The card under the chip is itself a button that opens the chat, so every
 * pointer and key event that reaches a link stops here: following a PR must
 * never also open the session behind it.
 */

export type PrStatus = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

/** A PR's state as GitHub shows it: a draft is an open PR that is not ready. */
export function prStatus(pr: PrInfo | null): PrStatus {
  if (!pr) return 'unknown';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

export const PR_STATUS_LABEL: Record<PrStatus, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', unknown: 'Pull request' };

const STATUS_TONE: Record<PrStatus, string> = {
  open: 'var(--success)',
  draft: 'var(--ink-faint)',
  merged: 'var(--merged-ink)',
  closed: 'var(--danger)',
  unknown: 'var(--ink-faint)',
};

/** The hue a PR takes from its state, as on GitHub. */
export function prTone(pr: PrInfo): string {
  return STATUS_TONE[prStatus(pr)];
}

/** GitHub's four PR glyphs, so the state reads at a glance before the colour does. */
export function PrStatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: PrStatus; className?: string }) {
  const common = { className: `${className} shrink-0`, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, 'data-pr-glyph': status };
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

/** Still in flight beats finished: open, then draft, then merged, then closed. */
const STATUS_RANK: Record<PrStatus, number> = { open: 0, draft: 1, merged: 2, closed: 3, unknown: 4 };

function createdMs(pr: PrInfo): number {
  const t = pr.createdAt ? Date.parse(pr.createdAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The PR the card shows when a chat has several: one still in flight over one
 * that is done, then the newest (by when it was opened, else the higher number).
 * Ties keep the given order, which puts the branch's own PR first.
 */
export function primaryPr(prs: PrInfo[]): PrInfo | undefined {
  let best: PrInfo | undefined;
  for (const pr of prs) {
    if (!best) { best = pr; continue; }
    const rank = STATUS_RANK[prStatus(pr)] - STATUS_RANK[prStatus(best)];
    if (rank < 0) { best = pr; continue; }
    if (rank > 0) continue;
    const opened = createdMs(pr), bestOpened = createdMs(best);
    if (opened !== bestOpened) {
      if (opened > bestOpened) best = pr;
    } else if (pr.number > best.number && pr.repo === best.repo && pr.owner === best.owner) {
      // Numbers only order PRs within one repository.
      best = pr;
    }
  }
  return best;
}

function prTitle(pr: PrInfo): string {
  return `${pr.owner}/${pr.repo}#${pr.number} · ${PR_STATUS_LABEL[prStatus(pr)]} · ${pr.title}`;
}

const openPr = (url: string) => void window.nekko.openPath(url).catch(() => {});

/** Keep a pointer or key event on a link from reaching the card that opens the chat. */
const isolate = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
  onDragStart: (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  },
};

/** The `+N`, with every PR listed in a popover above the sidebar's clipping. */
function PrOverflow({ prs, more }: { prs: PrInfo[]; more: number }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = hover || pinned;

  // A short grace period, so the pointer can cross from the count into the list.
  const enter = () => {
    clearTimeout(leaveTimer.current);
    setHover(true);
  };
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHover(false), 150);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const width = 260;
    setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 4 });
  }, [open]);

  // A pinned list closes on a click anywhere else, or on Escape.
  useEffect(() => {
    if (!pinned) return;
    const away = (e: MouseEvent) => {
      if (!popover.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [pinned]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="shrink-0 rounded-sm tabular-nums text-ink-faint hover:text-ink"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${prs.length} pull requests from this chat`}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
        {...isolate}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
      >
        +{more}
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={popover}
            role="menu"
            aria-label="Pull requests from this chat"
            className="fade-in fixed z-50 w-[260px] rounded-lg border border-line bg-paper p-1 text-2xs shadow-(--shadow-float)"
            style={{ left: pos.left, top: pos.top }}
            onMouseEnter={enter}
            onMouseLeave={leave}
            {...isolate}
          >
            {prs.map((pr) => (
              <a
                key={pr.url}
                role="menuitem"
                href={pr.url}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface-2 focus-visible:bg-surface-2"
                draggable={false}
                {...isolate}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openPr(pr.url);
                }}
                title={prTitle(pr)}
              >
                <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums" style={{ color: prTone(pr) }}>
                  <PrStatusIcon status={prStatus(pr)} className="h-3 w-3" />#{pr.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">{pr.title}</span>
                <span className="shrink-0 text-2xs text-ink-faint">{PR_STATUS_LABEL[prStatus(pr)].toLowerCase()}</span>
              </a>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A chat's PRs as one compact chip: the most relevant PR, then `+N` for the rest. */
export function SessionPrChip({ prs }: { prs: PrInfo[] }) {
  const pr = primaryPr(prs);
  if (!pr) return null;
  const status = prStatus(pr);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 leading-[13px]"
      data-session-pr-chip
      data-pr-status={status}
    >
      <a
        href={pr.url}
        className="inline-flex items-center gap-0.5 rounded-sm font-medium tabular-nums hover:underline focus-visible:underline"
        style={{ color: prTone(pr) }}
        title={prTitle(pr)}
        aria-label={`Pull request ${pr.number}, ${PR_STATUS_LABEL[status].toLowerCase()}`}
        draggable={false}
        {...isolate}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openPr(pr.url);
        }}
      >
        <PrStatusIcon status={status} className="h-3 w-3" />
        #{pr.number}
      </a>
      {prs.length > 1 && <PrOverflow prs={prs} more={prs.length - 1} />}
    </span>
  );
}
