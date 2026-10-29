import { createContext, useContext, useEffect, useState } from 'react';

/** The last width measured per key, and overall, to start the next mount from. */
const remembered = new Map<string, number>();
let lastWidth = 0;

/**
 * The measured width of an element, for layout decisions a CSS breakpoint can't
 * make: inside a splittable workbench, "is there room" is a question about the
 * pane, and the viewport can't answer it.
 *
 * A mount starts from the width this `key` (a chat) last had, or from the last
 * width measured at all, and the ResizeObserver corrects it after layout. That
 * keeps opening a chat to one render: measuring synchronously on mount forced
 * a layout and a second full render of the pane before its first frame. With
 * nothing to go on yet it still measures synchronously, so the very first
 * pane is never laid out at the wrong width. Returns 0 until a width is known,
 * so callers should treat 0 as "narrow" and let the real value arrive.
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>, key?: string): number {
  const [width, setWidth] = useState(() => (key ? remembered.get(key) : undefined) ?? lastWidth);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A pane kept mounted behind the scenes measures 0 while hidden; keep the
    // last real width rather than re-laying it out as "narrow" unseen.
    const remember = (w: number) => {
      if (w <= 0) return;
      lastWidth = w;
      if (key) remembered.set(key, w);
      setWidth(w);
    };
    if (!lastWidth) remember(el.clientWidth);
    // ChatPane's root has no padding or border, so the delivered content width
    // matches clientWidth. Avoid a layout read in observer delivery, where
    // another observer may already have invalidated layout. Keep integer widths
    // like clientWidth so fractional sizes don't change breakpoint decisions.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === el) remember(Math.round(entry.contentRect.width));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, key]);
  return width;
}

/** Under this width or height a chat folds its instrument strip into one summary chip. */
export const COMPACT_WIDTH = 470;
export const COMPACT_HEIGHT = 440;

/**
 * What a surface already knows about the room a window will have, before the
 * window has been laid out. The Agent board wall knows every window's
 * share of the stage, so it can say "compact" on the first render; a pane
 * mounted anywhere else starts full-size and folds once measured.
 */
export const PaneDensityHint = createContext<boolean | null>(null);

/**
 * Whether the element is small enough to call for the compact chat chrome:
 * a cell on the Agent board wall, or a window split down to a sliver.
 * Width and height both count, since a wide but short window has no more
 * room for two rows of controls than a narrow one.
 *
 * The size comes from the ResizeObserver's own entries, never from
 * `clientWidth`: reading that forced a layout of the whole document for
 * every chat window as it mounted, nine times over on a wall, and was the
 * single biggest cost in switching to it.
 */
export function useElementCompact(ref: React.RefObject<HTMLElement | null>): boolean {
  const hint = useContext(PaneDensityHint);
  const [compact, setCompact] = useState(hint ?? false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentBoxSize?.[0];
        const w = box ? box.inlineSize : entry.contentRect.width;
        const h = box ? box.blockSize : entry.contentRect.height;
        if (w <= 0 || h <= 0) continue;
        setCompact(w < COMPACT_WIDTH || h < COMPACT_HEIGHT);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return compact;
}
