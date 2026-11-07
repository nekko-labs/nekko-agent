import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandWallState } from '../commandWall.js';
import { ScreensControl } from './ScreensControl.js';

export const LAYOUT_LABEL = { focus: 'Single agent', grid: 'Multi-agent' } as const;
type Props = { wall: CommandWallState; setWall: (update: (s: CommandWallState) => CommandWallState) => void };

export function WallViewOptions({ wall, setWall }: Props) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const snapAvailable = wall.layout.mode === 'grid' && !wall.layout.fixedGrid;
  return <>
    <fieldset className="wall-view-layout">
      <legend className="screens-picker__title">Agent view</legend>
      {(['focus', 'grid'] as const).map((mode, i) => <label key={mode} className="screens-option">
        <input type="radio" name="wall-view-mode" data-view-mode={mode} checked={wall.layout.mode === mode}
          onChange={() => setWall(w => ({ ...w, layout: { ...w.layout, mode } }))} />
        <strong>{LAYOUT_LABEL[mode]}</strong><kbd className="kbd ml-auto">{mac ? '⌘' : 'Ctrl'}+Shift+{i + 1}</kbd>
      </label>)}
    </fieldset>
    <label className="screens-option" aria-disabled={!snapAvailable}>
      <input type="checkbox" data-view-snap checked={!!wall.snap} disabled={!snapAvailable}
        onChange={() => setWall(w => ({ ...w, snap: !w.snap }))} />
      <span><strong>Snap to grid</strong><span>{wall.layout.mode === 'focus' ? 'Available in Multi-agent view.' : wall.layout.fixedGrid ? 'Fixed grid already keeps windows evenly spaced.' : 'Keep windows evenly spaced; snap dividers near grid lines.'}</span></span>
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
    <button ref={anchor} type="button" className="btn btn-outline gap-2 py-1 text-xs" data-wall-view-toggle aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); requestAnimationFrame(() => pop.current?.querySelector<HTMLInputElement>('input:checked')?.focus()); } }}>
      View <span aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<div ref={pop} role="dialog" aria-label="View" data-wall-view-menu className="wall-view-menu" style={pos}
      onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && !anchor.current?.contains(e.relatedTarget)) setOpen(false); }}>
      <WallViewOptions {...props} />
    </div>, document.body)}
  </>;
}
