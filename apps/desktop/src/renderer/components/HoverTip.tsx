import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './commandWallLayouts.css';

/** How long the pointer rests on a control before its tip shows. */
export const SHOW_DELAY = 350;
/**
 * The warm window: once a tip has shown, sliding to the next control within
 * this long shows its tip at once and without the fade, the way a toolbar of
 * icons is read. Shared by every tip (HoverTip and the app-wide title tips),
 * so it spans controls.
 */
const WARM_MS = 600;
let warmUntil = 0;
const GAP = 6;
const MARGIN = 8;

export type TipSide = 'bottom' | 'top' | 'left' | 'right';
export type TipBox = { left: number; top: number; width: number; height: number };
export type TipPlacement = { left: number; top: number; side: TipSide };

/** True while a tip closed moments ago, so the next one shows at once. */
export function tipIsWarm(): boolean {
  return performance.now() < warmUntil;
}

/** Call when a visible tip closes: opens the warm window. */
export function markTipClosed(): void {
  warmUntil = performance.now() + WARM_MS;
}

/**
 * Where a tip of size `tip` goes beside `anchor`: on the asked side, flipped
 * when that side has no room, and kept inside the window. Returns the side it
 * actually took, so the entrance motion comes from the right direction.
 */
export function placeTip(anchor: TipBox, tip: { width: number; height: number }, side: TipSide, view = { width: window.innerWidth, height: window.innerHeight }): TipPlacement {
  const right = anchor.left + anchor.width, bottom = anchor.top + anchor.height;
  let placed = side;
  let left = side === 'left' ? anchor.left - tip.width - GAP : side === 'right' ? right + GAP : anchor.left + anchor.width / 2 - tip.width / 2;
  let top = side === 'top' ? anchor.top - tip.height - GAP : side === 'bottom' ? bottom + GAP : anchor.top + anchor.height / 2 - tip.height / 2;
  if (side === 'bottom' && top + tip.height > view.height - MARGIN) { top = anchor.top - tip.height - GAP; placed = 'top'; }
  if (side === 'top' && top < MARGIN) { top = bottom + GAP; placed = 'bottom'; }
  if (side === 'left' && left < MARGIN) { left = right + GAP; placed = 'right'; }
  if (side === 'right' && left + tip.width > view.width - MARGIN) { left = anchor.left - tip.width - GAP; placed = 'left'; }
  left = Math.max(MARGIN, Math.min(view.width - tip.width - MARGIN, left));
  top = Math.max(MARGIN, Math.min(view.height - tip.height - MARGIN, top));
  return { left, top, side: placed };
}

/**
 * The floating bubble every tooltip in the app draws: one rounded surface with
 * the popover shadow, placed beside its anchor in a portal so no
 * `overflow: hidden` panel can clip it. Measures itself after mounting, then
 * fades in and moves 4px out from the anchor.
 */
export function TipBubble({ id, anchor, side, instant, className = '', interactive = false, onPointerEnter, onPointerLeave, children }: {
  id: string;
  /** Returns the box to sit beside, read once the bubble has a size. */
  anchor: () => TipBox | null;
  side: TipSide;
  instant?: boolean;
  className?: string;
  /** A tip the pointer may move onto (scrollable details); others ignore the pointer. */
  interactive?: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: React.ReactNode;
}) {
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TipPlacement | null>(null);
  useLayoutEffect(() => {
    const box = anchor();
    if (!box || !tip.current) return;
    const t = tip.current.getBoundingClientRect();
    setPos(placeTip(box, t, side));
    // Re-place when the content changes size (a PR's state arriving, a new label).
  }, [anchor, side, children]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={tip} id={id} role="tooltip" className={`hover-tip${className ? ` ${className}` : ''}`}
      data-side={pos?.side ?? side} data-instant={instant || undefined} data-interactive={interactive || undefined}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

function boxOf(el: Element | null): TipBox | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * A hover/focus tooltip for one control. `label` is the plain text (also kept
 * on the control as `data-hover-tip`); `content` replaces what the bubble
 * shows with something richer, such as a PR's state and title. The control
 * never changes size: the words float beside it.
 *
 * Wraps exactly one element (a button or link); the tip shows on pointer hover
 * after a short delay and at once on keyboard focus, hides on leave, blur,
 * click and Escape, and is linked to the control with `aria-describedby`.
 */
export function HoverTip({ label, side = 'bottom', children, multiline = false, heading, content }: { label: string; side?: TipSide; children: React.ReactElement; multiline?: boolean; heading?: string; content?: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openRef = useRef(false);
  const [instant, setInstant] = useState(false);
  useEffect(() => { openRef.current = open; }, [open]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (openRef.current) markTipClosed();
    setOpen(false);
  }, []);
  const leave = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(hide, heading ? 180 : 0); }, [hide, heading]);
  const show = useCallback((delay: number) => {
    clearTimeout(timer.current);
    const warm = tipIsWarm();
    setInstant(warm || delay === 0);
    timer.current = setTimeout(() => setOpen(true), warm ? 0 : delay);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', key);
    const scroll = (e: Event) => { if (!(e.target instanceof Node) || !document.getElementById(id)?.contains(e.target)) hide(); };
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); };
  }, [open, hide, id]);
  const anchorBox = useCallback(() => boxOf(anchor.current), []);

  const child = React.Children.only(children) as React.ReactElement<Record<string, unknown>>;
  const props = child.props as Record<string, ((e: unknown) => void) | undefined>;
  const chain = (name: string, fn: () => void) => (e: unknown) => { props[name]?.(e); fn(); };
  const trigger = React.cloneElement(child, {
    ref: (el: HTMLElement | null) => { anchor.current = el; },
    'aria-describedby': open ? id : undefined,
    'data-hover-tip': label,
    onPointerEnter: chain('onPointerEnter', () => show(SHOW_DELAY)),
    onPointerLeave: chain('onPointerLeave', leave),
    onFocus: chain('onFocus', () => { if (anchor.current?.matches(':focus-visible')) show(0); }),
    onBlur: chain('onBlur', hide),
    onClick: chain('onClick', hide),
  });

  const variant = heading ? 'hover-tip-details' : content ? 'hover-tip-rich' : multiline ? 'hover-tip-multiline' : '';
  return <>
    {trigger}
    {open && (
      <TipBubble id={id} anchor={anchorBox} side={side} instant={instant} className={variant} interactive={!!heading}
        onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>
        {heading ? <><div className="hover-tip-heading">{heading}</div><pre className="hover-tip-content">{label}</pre></> : content ?? label}
      </TipBubble>
    )}
  </>;
}
