import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandWallState } from '../commandWall.js';
import { ScreensControl } from './ScreensControl.js';

export const LAYOUT_LABEL = { focus: 'Single agent', grid: 'Multi-agent' } as const;
type Props = { wall: CommandWallState; setWall: (update: (s: CommandWallState) => CommandWallState) => void };

/** Original layout glyph, shared by the trigger and the illustrated choices. */
export function AgentLayoutIcon({ mode, preview = false }: { mode: 'focus' | 'grid'; preview?: boolean }) {
  return <svg className={preview ? 'wall-view-preview' : 'wall-view-icon'} viewBox="0 0 40 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <rect className="wall-view-preview__frame" x="1" y="1" width="38" height="26" rx="4" />
    {mode === 'focus' ? <rect className="wall-view-preview__pane" x="5" y="5" width="30" height="18" rx="2" /> : <>
      <rect className="wall-view-preview__pane" x="5" y="5" width="13" height="18" rx="2" />
      <rect className="wall-view-preview__pane" x="22" y="5" width="13" height="7" rx="2" />
      <rect className="wall-view-preview__pane" x="22" y="16" width="13" height="7" rx="2" />
    </>}
  </svg>;
}

export function WallViewOptions({ wall, setWall }: Props) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const snapAvailable = wall.layout.mode === 'grid' && !wall.layout.fixedGrid;
  return <>
    <header className="wall-view-heading"><h2>Workspace view</h2><p>Choose how agents share this window.</p></header>
    <fieldset className="wall-view-layout">
      <legend className="sr-only">Agent view</legend>
      <div className="wall-view-choices">
        {(['focus', 'grid'] as const).map((mode, i) => <label key={mode} className="wall-view-choice">
          <input type="radio" name="wall-view-mode" data-view-mode={mode} checked={wall.layout.mode === mode}
            onChange={() => setWall(w => ({ ...w, layout: { ...w.layout, mode } }))} />
          <AgentLayoutIcon mode={mode} preview />
          <strong>{LAYOUT_LABEL[mode]}</strong>
          <span className="wall-view-choice__hint">{mode === 'focus' ? 'One chat at a time' : 'Chats side by side'}</span>
          <kbd>{mac ? '⌘' : 'Ctrl'}+Shift+{i + 1}</kbd>
        </label>)}
      </div>
    </fieldset>
    <label className="wall-view-snap" aria-disabled={!snapAvailable}>
      <span><strong>Snap to grid</strong><span>{wall.layout.mode === 'focus' ? 'Use Multi-agent to align windows.' : wall.layout.fixedGrid ? 'Fixed grid already aligns windows.' : 'Align dividers as you resize windows.'}</span></span>
      <input type="checkbox" role="switch" data-view-snap checked={!!wall.snap} disabled={!snapAvailable}
        onChange={() => setWall(w => ({ ...w, snap: !w.snap }))} />
    </label>
    <ScreensControl mode={wall.layout.mode} embedded />
  </>;
}

/** One viewport-bounded popover, including screen controls rather than a nested menu. */
export function WallViewMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), p = pop.current?.getBoundingClientRect();
      if (a && p) setPos({ left: Math.max(8, Math.min(a.right - p.width, innerWidth - p.width - 8)), top: Math.max(8, Math.min(a.bottom + 6, innerHeight - p.height - 8)) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (pop.current) observer.observe(pop.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  return <>
    <button ref={anchor} type="button" className="wall-view-trigger" data-wall-view-toggle aria-haspopup="dialog" aria-expanded={open} title={`View: ${LAYOUT_LABEL[props.wall.layout.mode]}`}
      onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); requestAnimationFrame(() => pop.current?.querySelector<HTMLInputElement>('input:checked')?.focus()); } }}>
      <AgentLayoutIcon mode={props.wall.layout.mode} />
      View <svg className="wall-view-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open && createPortal(<div ref={pop} role="dialog" aria-label="View" data-wall-view-menu className="wall-view-menu" style={pos}
      onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && !anchor.current?.contains(e.relatedTarget)) setOpen(false); }}>
      <WallViewOptions {...props} />
    </div>, document.body)}
  </>;
}
