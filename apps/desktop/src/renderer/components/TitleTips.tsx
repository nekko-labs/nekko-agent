import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { SHOW_DELAY, TipBubble, markTipClosed, tipIsWarm, type TipBox } from './HoverTip.js';

/** The attribute a hovered element's `title` waits in while our tip shows instead. */
const STASH = 'data-title-tip';
/** Bigger than this, the tip follows the pointer rather than centring on the element. */
const LARGE_W = 320;
const LARGE_H = 48;
/** The height of the pointer, so a tip under it clears the cursor. */
const CURSOR_H = 18;

type Held = { el: Element; text: string; addedLabel: boolean; point: { x: number; y: number } | null };
type Shown = { el: Element; text: string; instant: boolean; point: { x: number; y: number } | null };

/** The nearest element with a native tooltip, unless something else owns its tip. */
export function titledAncestor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(`[title], [${STASH}]`);
  if (!el || el instanceof HTMLIFrameElement || el.closest('[role="tooltip"], [data-hover-tip], [data-native-title]')) return null;
  const text = el.getAttribute('title') ?? el.getAttribute(STASH) ?? '';
  return text.trim() ? el : null;
}

/** The box a title tip sits beside: the element itself, or the pointer over a large one. */
export function titleTipAnchor(rect: TipBox, point: { x: number; y: number } | null): TipBox {
  if (!point || (rect.width <= LARGE_W && rect.height <= LARGE_H)) return rect;
  return { left: point.x, top: point.y, width: 0, height: CURSOR_H };
}

/**
 * Draws every native `title` tooltip in the app as our own tip, so the
 * hundreds of controls that use `title` share one look with `HoverTip`
 * without each call site changing. Mounted once at the root.
 *
 * While the pointer (or keyboard focus) is on a titled element, its `title`
 * moves to `data-title-tip` so the system tooltip never also appears, and
 * moves back when the pointer leaves. An icon-only control whose only name
 * was its title gets the same words as `aria-label` for that time, so a
 * screen reader never finds it nameless. Opt an element out with
 * `data-native-title`.
 */
export function TitleTips() {
  const id = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const held = useRef<Held | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watcher = useRef<MutationObserver | null>(null);
  const shownRef = useRef(false);
  useEffect(() => { shownRef.current = !!shown; }, [shown]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (shownRef.current) markTipClosed();
    setShown(null);
    const el = held.current?.el;
    if (el?.getAttribute('aria-describedby') === id) el.removeAttribute('aria-describedby');
  }, [id]);

  /** Give the held element its title back. */
  const release = useCallback(() => {
    hide();
    watcher.current?.disconnect();
    watcher.current = null;
    const h = held.current;
    held.current = null;
    if (!h) return;
    if (h.el.hasAttribute(STASH)) {
      h.el.removeAttribute(STASH);
      h.el.setAttribute('title', h.text);
    }
    if (h.addedLabel) h.el.removeAttribute('aria-label');
  }, [hide]);

  const open = useCallback((h: Held, delay: number) => {
    clearTimeout(timer.current);
    const warm = tipIsWarm();
    timer.current = setTimeout(() => {
      if (held.current !== h || !h.el.isConnected) return;
      h.el.setAttribute('aria-describedby', id);
      setShown({ el: h.el, text: h.text, instant: warm || delay === 0, point: h.point });
    }, warm ? 0 : delay);
  }, [id]);

  /** Take over `el`'s title: stash it, watch it, and schedule the tip. */
  const hold = useCallback((el: Element, point: { x: number; y: number } | null, delay: number) => {
    if (held.current?.el === el) return;
    release();
    const text = el.getAttribute('title') ?? el.getAttribute(STASH) ?? '';
    el.removeAttribute('title');
    el.setAttribute(STASH, text);
    const nameless = !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent?.trim();
    if (nameless) el.setAttribute('aria-label', text);
    const h: Held = { el, text, addedLabel: nameless, point };
    held.current = h;
    // React may set the title again while it is held (a label that changes
    // with state), and the element may leave the page under the pointer.
    watcher.current = new MutationObserver(() => {
      if (!el.isConnected) { release(); return; }
      const next = el.getAttribute('title');
      if (next === null) return;
      el.removeAttribute('title');
      if (!next.trim()) { release(); return; }
      h.text = next;
      el.setAttribute(STASH, next);
      if (h.addedLabel) el.setAttribute('aria-label', next);
      setShown((s) => (s && s.el === el ? { ...s, text: next } : s));
    });
    watcher.current.observe(el, { attributes: true, attributeFilter: ['title'] });
    if (el.parentNode) watcher.current.observe(el.parentNode, { childList: true });
    open(h, delay);
  }, [open, release]);

  useEffect(() => {
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = titledAncestor(e.target);
      if (el) hold(el, { x: e.clientX, y: e.clientY }, SHOW_DELAY);
      else if (held.current && !(e.target instanceof Node && held.current.el.contains(e.target))) release();
    };
    const out = (e: PointerEvent) => {
      const h = held.current;
      if (!h) return;
      const to = e.relatedTarget;
      if (to instanceof Node && h.el.contains(to)) return;
      // Leaving to a nested titled element is handled by its pointerover.
      if (!to) release();
    };
    const focus = (e: FocusEvent) => {
      const el = titledAncestor(e.target);
      if (el && el === e.target && el.matches(':focus-visible')) hold(el, null, 0);
    };
    const blur = (e: FocusEvent) => { if (held.current && held.current.el === e.target) release(); };
    // A press or a scroll closes the tip, as the system tooltip does; it
    // comes back only after the pointer leaves and returns.
    const press = () => { clearTimeout(timer.current); hide(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') press(); };
    const scroll = () => { if (held.current) press(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    document.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', blur, true);
      document.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, [hold, release, hide]);

  const anchor = useCallback((): TipBox | null => {
    if (!shown || !shown.el.isConnected) return null;
    const r = shown.el.getBoundingClientRect();
    return titleTipAnchor({ left: r.left, top: r.top, width: r.width, height: r.height }, shown.point);
  }, [shown]);

  if (!shown) return null;
  return <TipBubble id={id} anchor={anchor} side="bottom" instant={shown.instant}>{shown.text}</TipBubble>;
}

export default TitleTips;
