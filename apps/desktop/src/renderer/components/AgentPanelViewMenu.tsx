import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ChevronIcon } from '../icons.js';
import {
  DEFAULT_AGENT_PANEL_VIEW, GROUP_BY_LABELS, SORT_BY_LABELS, isDefaultView, withSort,
  type AgentGroupBy, type AgentPanelView, type AgentSortBy,
} from '../views/agentPanelView.js';

type Sub = 'group' | 'sort' | 'show';

const MENU_W = 236;
const SUB_W = 210;

/**
 * The Agents panel's view menu: what the cards are grouped by, the order they
 * are in, and what is shown. Each top row names its current choice and opens a
 * submenu beside it on hover, a click or the right arrow, so the whole panel
 * can be rearranged without the menu closing between choices.
 *
 * Opened from the panel's sliders button, or by right-clicking a group header.
 */
export function AgentPanelViewMenu({ x, y, view, onChange, onClose }: {
  x: number;
  y: number;
  view: AgentPanelView;
  onChange: (next: AgentPanelView) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Partial<Record<Sub, HTMLButtonElement | null>>>({});
  const [sub, setSub] = useState<Sub | null>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  const closeTimer = useRef(0);

  useEffect(() => {
    ref.current?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !subRef.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // Escape backs out of a submenu first, then closes the menu.
      setSub((open) => { if (!open) onClose(); return null; });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
      window.clearTimeout(closeTimer.current);
    };
  }, [onClose]);

  // A submenu opens to the right of its row, or to the left when the window
  // has no room there, and never runs off the bottom.
  useLayoutEffect(() => {
    const row = sub ? rowRefs.current[sub] : null;
    if (!row) { setSubPos(null); return; }
    const r = row.getBoundingClientRect();
    const h = subRef.current?.offsetHeight ?? 180;
    const right = r.right + 6;
    const left = right + SUB_W > window.innerWidth - 8 ? Math.max(8, r.left - SUB_W - 6) : right;
    setSubPos({ left, top: Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8)) });
  }, [sub]);

  const openSub = (next: Sub) => { window.clearTimeout(closeTimer.current); setSub(next); };
  // Leaving a row starts a short grace period, so the diagonal to the submenu
  // is crossable without it closing under the pointer.
  const closeSubSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setSub(null), 240);
  };
  const keepSub = () => window.clearTimeout(closeTimer.current);
  const focusSub = () => requestAnimationFrame(() => subRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus());

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 220));

  const topRow = (id: Sub, label: string, value?: string) => (
    <button
      ref={(el) => { rowRefs.current[id] = el; }}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={sub === id}
      data-view-menu-row={id}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-1 text-left text-sm ${sub === id ? 'bg-surface-2 text-ink' : 'text-ink-soft hover:bg-surface-2 hover:text-ink'}`}
      onMouseEnter={() => openSub(id)}
      onMouseLeave={closeSubSoon}
      onClick={() => { openSub(id); focusSub(); }}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); openSub(id); focusSub(); } }}
    >
      <span className="flex-1">{label}</span>
      {value && <span className="truncate text-xs text-ink-faint">{value}</span>}
      <ChevronIcon className="h-3 w-3 shrink-0 text-ink-faint" />
    </button>
  );

  const set = (patch: Partial<AgentPanelView>) => onChange({ ...view, ...patch });

  return createPortal(
    <>
      <div
        ref={ref}
        role="menu"
        aria-label="Agent panel view"
        tabIndex={-1}
        data-agent-view-menu
        className="context-menu card fixed z-[1000] p-2 shadow-(--shadow-float) outline-hidden"
        style={{ left, top, width: MENU_W }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }}
      >
        {topRow('group', 'Group by', GROUP_BY_LABELS[view.groupBy])}
        {topRow('sort', 'Sort by', SORT_BY_LABELS[view.sortBy])}
        {topRow('show', 'Show')}
        <div className="mx-2 my-1 h-px bg-line" role="separator" />
        <button
          role="menuitem"
          disabled={isDefaultView(view)}
          className="block w-full rounded-lg px-3 py-1 text-left text-sm text-ink-soft hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          onMouseEnter={() => setSub(null)}
          onClick={() => onChange(DEFAULT_AGENT_PANEL_VIEW)}
        >
          Reset to defaults
        </button>
      </div>
      {sub && (
        <div
          ref={subRef}
          role="menu"
          aria-label={sub === 'group' ? 'Group by' : sub === 'sort' ? 'Sort by' : 'Show'}
          data-agent-view-submenu={sub}
          className="context-menu card fixed z-[1001] p-2 shadow-(--shadow-float)"
          style={{ width: SUB_W, left: subPos?.left ?? -9999, top: subPos?.top ?? -9999 }}
          onMouseEnter={keepSub}
          onMouseLeave={closeSubSoon}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); setSub(null); rowRefs.current[sub]?.focus(); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...(subRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
          }}
        >
          {sub === 'group' && <>
            {(['status', 'project', 'date'] as AgentGroupBy[]).map((g) => (
              <Choice key={g} checked={view.groupBy === g} onClick={() => set({ groupBy: g })}>{GROUP_BY_LABELS[g]}</Choice>
            ))}
            <Divider />
            <Choice checked={view.groupBy === 'none'} onClick={() => set({ groupBy: 'none' })}>None</Choice>
          </>}
          {sub === 'sort' && <>
            {(['manual', 'updated', 'created', 'name'] as AgentSortBy[]).map((s) => (
              <Choice key={s} checked={view.sortBy === s} onClick={() => onChange(withSort(view, s))}
                title={s === 'manual' ? 'The order you dragged cards into, newest first for the rest' : undefined}>
                {SORT_BY_LABELS[s]}
              </Choice>
            ))}
            <Divider />
            {/* Manual order has no direction: it is whatever you dragged. */}
            <Choice checked={view.sortBy !== 'manual' && view.direction === 'desc'} disabled={view.sortBy === 'manual'} onClick={() => set({ direction: 'desc' })}>Descending</Choice>
            <Choice checked={view.sortBy !== 'manual' && view.direction === 'asc'} disabled={view.sortBy === 'manual'} onClick={() => set({ direction: 'asc' })}>Ascending</Choice>
          </>}
          {sub === 'show' && <>
            <Choice toggle checked={view.showMetadata} onClick={() => set({ showMetadata: !view.showMetadata })}
              title="The model, context, git and sub-agent lines under each card">Metadata</Choice>
            <Choice toggle checked={view.showMetadata && view.showProvider} disabled={!view.showMetadata} onClick={() => set({ showProvider: !view.showProvider })}
              title="Where each card's model comes from, under the model">Model provider</Choice>
            <Divider />
            <Choice toggle checked={view.showAutomations} onClick={() => set({ showAutomations: !view.showAutomations })}
              title="Chats an automation started">Automations</Choice>
            <Choice toggle checked={view.showEmptyGroups} onClick={() => set({ showEmptyGroups: !view.showEmptyGroups })}
              title="Groups with no active agents">Empty groups</Choice>
          </>}
        </div>
      )}
    </>,
    document.body,
  );
}

function Divider() {
  return <div className="mx-2 my-1 h-px bg-line" role="separator" />;
}

/** A submenu row with its check on the right, as a radio choice or a toggle. */
function Choice({ checked, toggle = false, disabled = false, title, onClick, children }: {
  checked: boolean;
  toggle?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role={toggle ? 'menuitemcheckbox' : 'menuitemradio'}
      aria-checked={checked}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1 text-left text-sm text-ink-soft hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      <span className="flex-1">{children}</span>
      <CheckIcon className={`h-3.5 w-3.5 shrink-0 text-accent ${checked ? '' : 'invisible'}`} />
    </button>
  );
}
