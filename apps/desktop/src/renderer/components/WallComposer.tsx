import { NumberedChatIcon } from './NumberedChatIcon.js';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agent-nekko/shared';
import { ChatPane } from './ChatPane.js';
import { ChatIcon, ExternalIcon, LayoutIcon } from '../icons.js';
import { type ComposerDock, type ComposerAlign, type ComposerSide } from '../commandWall.js';

/** One agent window the composer can be pointed at: its number on the wall and what it is doing. */
export interface WallAgent {
  session: SessionSummary;
  /** 1-based position among the wall's agent windows, in reading order. */
  n: number;
  status: { label: string; tone: string; live?: boolean } | null;
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
  agent,
  agents,
  dock,
  onDock,
  onSelect,
  onOpen,
  onNewAgent,
  panelRef,
}: {
  height?: number | null;
  agent: WallAgent | null;
  agents: WallAgent[];
  dock: ComposerDock;
  onDock: (dock: ComposerDock) => void;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onNewAgent: () => void;
  /** The composer panel, used to focus the selected chat input. */
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
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

  const alignClass = dock.align === 'left' ? 'self-start' : dock.align === 'right' ? 'self-end' : 'self-center';

  return (
    <div
      ref={panelRef}
      style={{ height: height ?? 320 }}
      className={`panel wall-composer flex shrink-0 flex-col ${alignClass}`}
      data-has-agent={agent ? true : undefined}
      data-wall-composer
      data-dock={`${dock.side}-${dock.align}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]">
        <NumberedChatIcon number={agent?.n} />
        {agent ? (
          <>
            {/* Same as the agent window: the status is a dot leading the title. */}
            {agent.status && (
              <span
                role="img"
                aria-label={agent.status.label}
                title={agent.status.label}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${agent.status.live ? 'animate-pulse' : ''}`}
                style={{ background: agent.status.tone }}
              />
            )}
            <span className="min-w-0 truncate font-medium" data-composer-title>{agent.session.title}</span>
          </>
        ) : (
          <span className="text-ink-faint" data-composer-title>No agent selected</span>
        )}
        <span className="hidden text-[11px] text-ink-faint md:inline" style={{ marginLeft: 8 }}>
          {agents.length > 1 ? 'Ctrl+Tab cycles windows · Ctrl+1…9 picks one' : agents.length === 1 ? '' : ''}
        </span>
        <div className="min-w-0 flex-1" />
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
      </div>
      {agent ? (
        <div className="wall-composer-body min-h-0">
          <ChatPane key={agent.session.id} sessionId={agent.session.id} commandCenter surface="composer" />
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
