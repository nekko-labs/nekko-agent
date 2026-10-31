import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrInfo } from '@nekko-agent/shared';

/**
 * The PRs a chat made, as links on its sidebar card: one `#123` per PR, up to
 * three. Past that the card has no room, so they fold into a pull-request
 * glyph and a count that lists every PR on hover (or click, for keyboard and
 * touch), each one its own link.
 *
 * The card under these is itself a button that opens the chat, so every
 * pointer and key event that reaches a link stops here: following a PR must
 * never also open the session behind it.
 */

/** PRs shown as individual links before they fold into a count. */
export const MAX_INLINE_PRS = 3;

/** The hue a PR's link takes from its state, as on GitHub. */
export function prTone(pr: PrInfo): string {
  if (pr.state === 'merged') return 'var(--merged-ink)';
  if (pr.state === 'closed') return 'var(--danger)';
  if (pr.isDraft) return 'var(--ink-faint)';
  return 'var(--success)';
}

function stateLabel(pr: PrInfo): string {
  if (pr.state === 'open') return pr.isDraft ? 'draft' : 'open';
  return pr.state;
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

export function PullRequestIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4" />
      <path d="m13 3.5-2.5 2.5L13 8.5" />
    </svg>
  );
}

function PrLink({ pr }: { pr: PrInfo }) {
  return (
    <a
      href={pr.url}
      className="shrink-0 rounded-sm font-medium tabular-nums hover:underline focus-visible:underline"
      style={{ color: prTone(pr) }}
      title={`${pr.owner}/${pr.repo}#${pr.number} · ${stateLabel(pr)} · ${pr.title}`}
      draggable={false}
      {...isolate}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openPr(pr.url);
      }}
    >
      #{pr.number}
    </a>
  );
}

/** The folded count, with every PR listed in a popover above the sidebar's clipping. */
function PrOverflow({ prs }: { prs: PrInfo[] }) {
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
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 });
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
        className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-ink-soft hover:text-ink"
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
        <PullRequestIcon className="h-2.5 w-2.5" />
        <span className="tabular-nums">{prs.length}</span>
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
                className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2 focus-visible:bg-surface-2"
                draggable={false}
                {...isolate}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openPr(pr.url);
                }}
                title={`${pr.owner}/${pr.repo}#${pr.number} · ${stateLabel(pr)}`}
              >
                <span className="shrink-0 font-medium tabular-nums" style={{ color: prTone(pr) }}>#{pr.number}</span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">{pr.title}</span>
                <span className="shrink-0 text-2xs text-ink-faint">{stateLabel(pr)}</span>
              </a>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function SessionPrLinks({ prs }: { prs: PrInfo[] }) {
  if (!prs.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {prs.length > MAX_INLINE_PRS ? <PrOverflow prs={prs} /> : prs.map((pr) => <PrLink key={pr.url} pr={pr} />)}
    </span>
  );
}
