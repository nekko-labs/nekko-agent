import { NumberedAgentIcon } from './NumberedChatIcon.js';
import { StatusIcon, type AgentStatus } from './WorkspaceCard.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@nekko-agent/shared';
import { ChatPane } from './ChatPane.js';
import { observeWallComposer } from '../composerSizing.js';
import { ChatIcon, FocusLayoutIcon, LayoutIcon } from '../icons.js';
import { composerMaxWidth, type ComposerDock, type ComposerAlign, type ComposerSide } from '../commandWall.js';

/** One agent window the composer can be pointed at: its number on the wall and what it is doing. */
export interface WallAgent {
  session: SessionSummary;
  /** 1-based position among the wall's agent windows, in reading order. */
  n: number;
  status: { label: string; tone: string; live?: boolean } | null;
  /** The same state as a glyph: rocket working, Zz idle. */
  glyph?: AgentStatus;
}

const SIDES: ComposerSide[] = ['top', 'bottom'];
const ALIGNS: ComposerAlign[] = ['left', 'center', 'right'];
const DOCK_LABEL: Record<ComposerSide, string> = { top: 'Top', bottom: 'Bottom' };
const ALIGN_LABEL: Record<ComposerAlign, string> = { left: 'left', center: 'centre', right: 'right' };

/**
 * The one composer for the whole wall. It belongs to whichever agent window
 * is selected (a click on the window, Ctrl+Tab, or Ctrl+1…9), and shows that
 * chat's drafting controls: mode, tools, image settings when it is an image
 * chat, and the queue. Model selection, questions and approvals stay in the
 * corresponding agent window. It docks to one of six places around the wall while the selected window and its number identify who it speaks for.
 */
export function WallComposer({
  height,
  resizeHandle,
  agent,
  agents,
  dock,
  onDock,
  onWidth,
  onSelect,
  onOpen,
  onFocus,
  onNewAgent,
  panelRef,
}: {
  height?: number | null;
  resizeHandle?: React.ReactNode;
  agent: WallAgent | null;
  agents: WallAgent[];
  dock: ComposerDock;
  onDock: (dock: ComposerDock) => void;
  /** The dragged width (null to reset), saved with the wall so it survives leaving the page. */
  onWidth: (width: number | null) => void;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onNewAgent: () => void;
  /** The composer panel, used to focus the selected chat input. */
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  // The dragged width lives in the wall's saved state, not here: this
  // component unmounts whenever another page is shown, and a width kept in it
  // was forgotten every time.
  const width = dock.width ?? null;
  const setWidth = onWidth;
  const widthDrag = useRef<{ x: number; width: number; edge: 'left' | 'right' } | null>(null);
  const resizeWidth = (next: number) => {
    const available = composerMaxWidth(panelRef.current);
    setWidth(Math.round(Math.max(Math.min(320, available), Math.min(available, next))));
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [pickerOpen]);

  // A newly selected agent gets the caret: selecting from the wall or the
  // keyboard means "talk to this one", so typing can start at once.
  useLayoutEffect(() => {
    if (!agent) return;
    const id = requestAnimationFrame(() => {
      const input = panelRef.current?.querySelector<HTMLElement>('.composer [contenteditable]:not([contenteditable="false"]), .composer textarea');
      if (input && document.activeElement !== input && !panelRef.current?.contains(document.activeElement)) input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [agent?.session.id, panelRef]);

  // Grow the editor with its rendered text and keep every control row in the shell.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !agent) return;
    return observeWallComposer(panel, height ?? null);
  }, [panelRef, agent?.session.id, height]);

  // A saved width wider than the wall now (a smaller window, the panels
  // opened) is drawn at the wall's width and keeps its saved value for when
  // there is room again. The cap follows the windows' stage as it resizes.
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stage = panel?.closest('.wall-column')?.querySelector<HTMLElement>('.command-wall-stage');
    const update = () => { const next = composerMaxWidth(panelRef.current); setMaxWidth((prev) => (prev === next ? prev : next)); };
    update();
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [panelRef]);

  const alignClass = dock.align === 'left' ? 'self-start' : dock.align === 'right' ? 'self-end' : 'self-center';

  // Which agent this composer speaks for, its status, and where the composer
  // sits. It is the composer's own first row (ChatPane `header`), not a bar
  // above it; with no agent selected it stands alone over the prompt.
  const head = (
    <>
          <NumberedAgentIcon number={agent?.n} />
          {agent ? (
            <>
              <span className="min-w-0 truncate font-medium" data-composer-title title={agents.length > 1 ? `${agent.session.title} · Ctrl+Tab cycles windows, Ctrl+1…9 selects one` : agent.session.title}>{agent.session.title}</span>
              {agent.status && (
                <span className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: agent.status.tone }}>
                  <StatusIcon status={agent.glyph} />
                  <span className="truncate">{agent.status.label}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-ink-faint" data-composer-title>No agent selected</span>
          )}
          <div className="min-w-0 flex-1" />
          {agent && <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Show selected chat in Focus" aria-label="Show selected chat in Focus" onClick={() => onFocus(agent.session.id)}><FocusLayoutIcon className="h-3.5 w-3.5" /></button>}
          <div className="relative" ref={pickerRef}>
            <button
              className={`flex items-center gap-1 rounded-sm p-1 text-ink-faint hover:text-ink ${pickerOpen ? 'text-ink' : ''}`}
              title={`Composer docked ${DOCK_LABEL[dock.side].toLowerCase()} ${ALIGN_LABEL[dock.align]}. Click to move it.`}
              aria-label="Move the composer"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((o) => !o)}
            >
              <LayoutIcon className="h-3.5 w-3.5" />
            </button>
            {pickerOpen && (
              <div className="card absolute right-0 top-8 z-40 p-2.5 shadow-lg" style={{ background: 'var(--paper)' }} role="dialog" aria-label="Where the composer sits">
                <p className="mb-1.5 px-0.5 text-[11px] text-ink-faint">Where should the composer sit?</p>
                <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, 44px)' }} role="grid">
                  {SIDES.map((side) => ALIGNS.map((align) => {
                    const on = dock.side === side && dock.align === align;
                    return (
                      <button
                        key={`${side}-${align}`}
                        role="gridcell"
                        aria-label={`${DOCK_LABEL[side]} ${ALIGN_LABEL[align]}`}
                        aria-selected={on}
                        className="relative h-[30px] rounded-md border transition-colors"
                        style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', background: on ? 'var(--accent-soft)' : 'var(--surface-2)' }}
                        onClick={() => { onDock({ side, align }); setPickerOpen(false); }}
                        title={`${DOCK_LABEL[side]} ${ALIGN_LABEL[align]}`}
                      >
                        {/* A little bar where the composer would be in that cell. */}
                        <span
                          className="absolute h-[5px] w-[22px] rounded-sm"
                          style={{
                            background: on ? 'var(--accent)' : 'var(--ink-faint)',
                            top: side === 'top' ? 5 : undefined,
                            bottom: side === 'bottom' ? 5 : undefined,
                            left: align === 'left' ? 5 : align === 'center' ? '50%' : undefined,
                            right: align === 'right' ? 5 : undefined,
                            transform: align === 'center' ? 'translateX(-50%)' : undefined,
                          }}
                        />
                      </button>
                    );
                  }))}
                </div>
              </div>
            )}
          </div>
    </>
  );

  return (
    <div
      ref={panelRef}
      // The shell stays in normal flex flow and includes every control row.
      style={{ width: width ?? undefined, maxWidth: maxWidth ?? undefined }}
      className={`panel wall-composer flex shrink-0 flex-col ${alignClass}`}
      data-has-agent={agent ? true : undefined}
      data-wall-composer
      data-dock={`${dock.side}-${dock.align}`}
    >
      {resizeHandle}
      {(['left', 'right'] as const).map(edge => <div key={edge} className="wall-composer-side" data-edge={edge} role="separator" tabIndex={0} aria-label={`Resize composer from ${edge} side`} aria-orientation="vertical" title="Drag to resize composer width; double-click to reset"
        onPointerDown={e => { widthDrag.current = { x: e.clientX, width: panelRef.current?.offsetWidth ?? 320, edge }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { const drag = widthDrag.current; if (!drag) return; const factor = dock.align === 'center' ? 2 : 1; resizeWidth(drag.width + (e.clientX - drag.x) * (drag.edge === 'left' ? -1 : 1) * factor); }}
        onPointerUp={() => { widthDrag.current = null; }} onPointerCancel={() => { widthDrag.current = null; }} onLostPointerCapture={() => { widthDrag.current = null; }}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={e => { if (e.key === 'Home') { e.preventDefault(); setWidth(null); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); resizeWidth((panelRef.current?.offsetWidth ?? 320) + (e.key === 'ArrowRight' ? 20 : -20) * (edge === 'left' ? -1 : 1)); } }} />)}
      {!agent && <div className="composer-head flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]" data-composer-head>{head}</div>}
      {agent ? (
        <div className="wall-composer-body min-h-0">
          <ChatPane key={agent.session.id} sessionId={agent.session.id} commandCenter surface="composer" header={head} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 px-4 py-4 text-[12.5px] text-ink-faint">
          <span>Click an agent window to talk to it here, or start one.</span>
          <button className="btn btn-primary py-1 text-[12px]" onClick={onNewAgent}><ChatIcon className="h-3.5 w-3.5" /> New agent</button>
          {agents.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {agents.map((a) => (
                <button key={a.session.id} className="chip chip-action text-[11px]" onClick={() => onSelect(a.session.id)}><span className="wall-num">{a.n}</span>{a.session.title}</button>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
