import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './commandWallLayouts.css';

/** How long the pointer rests on a control before its tip shows. */
const SHOW_DELAY = 350;
const GAP = 6;
const MARGIN = 8;

type Side = 'bottom' | 'top' | 'left' | 'right';

/**
 * A small hover/focus tooltip for icon-only controls. It renders in a portal
 * at a fixed position, so a panel with `overflow: hidden` (the agent panel,
 * the monitors dock) cannot clip it, and it never changes the control's own
 * size: the control stays an icon and the words float beside it.
 *
 * Wraps exactly one element (a button); the tip shows on pointer hover after a
 * short delay and at once on keyboard focus, hides on leave, blur, click and
 * Escape, and is linked to the control with `aria-describedby`.
 */
export function HoverTip({ label, side = 'bottom', children }: { label: string; side?: Side; children: React.ReactElement }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = useCallback(() => { clearTimeout(timer.current); setOpen(false); setPos(null); }, []);
  const show = useCallback((delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('scroll', hide, true); };
  }, [open, hide]);

  // Measure after the tip mounts, then place it beside the control and keep it on screen.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    let left = side === 'left' ? a.left - t.width - GAP : side === 'right' ? a.right + GAP : a.left + a.width / 2 - t.width / 2;
    let top = side === 'top' ? a.top - t.height - GAP : side === 'bottom' ? a.bottom + GAP : a.top + a.height / 2 - t.height / 2;
    if (side === 'bottom' && top + t.height > window.innerHeight - MARGIN) top = a.top - t.height - GAP;
    if (side === 'top' && top < MARGIN) top = a.bottom + GAP;
    left = Math.max(MARGIN, Math.min(window.innerWidth - t.width - MARGIN, left));
    top = Math.max(MARGIN, Math.min(window.innerHeight - t.height - MARGIN, top));
    setPos({ left, top });
  }, [open, side, label]);

  const child = React.Children.only(children) as React.ReactElement<Record<string, unknown>>;
  const props = child.props as Record<string, ((e: unknown) => void) | undefined>;
  const chain = (name: string, fn: () => void) => (e: unknown) => { props[name]?.(e); fn(); };
  const trigger = React.cloneElement(child, {
    ref: (el: HTMLElement | null) => { anchor.current = el; },
    'aria-describedby': open ? id : undefined,
    'data-hover-tip': label,
    onPointerEnter: chain('onPointerEnter', () => show(SHOW_DELAY)),
    onPointerLeave: chain('onPointerLeave', hide),
    onFocus: chain('onFocus', () => { if (anchor.current?.matches(':focus-visible')) show(0); }),
    onBlur: chain('onBlur', hide),
    onClick: chain('onClick', hide),
  });

  return <>
    {trigger}
    {open && typeof document !== 'undefined' && createPortal(
      <div ref={tip} id={id} role="tooltip" className="hover-tip" data-side={side}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: 'hidden' }}>
        {label}
      </div>,
      document.body,
    )}
  </>;
}
