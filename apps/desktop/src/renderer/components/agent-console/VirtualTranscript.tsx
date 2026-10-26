import React, { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RowKeyContext, RowMemoryContext } from './rowState.js';
import { bottomRange, isPinned, prefixOffsets, rangeFor, sameRange, shiftAbove, type RowRange } from './virtualGeometry.js';

/**
 * The transcript, windowed: only the rows near the viewport are in the DOM.
 *
 * A chat with thousands of messages used to mount (and re-render) every one of
 * them, so typing, streaming and switching all paid for the whole history.
 * Here each row is measured once it has rendered, by one ResizeObserver shared
 * across the list, and its height is cached by row key (per chat, so coming
 * back to a chat starts from real sizes). Rows that have never rendered are
 * placed by an estimate; the space above and below the rendered window is
 * padding on the list, so the scrollbar still spans the whole conversation.
 *
 * Scrolling follows the old contract. While the reader is at the bottom the
 * list sticks there as the reply grows; once they scroll up it stays put, and
 * when a row above them changes size (an estimate corrected by a measurement)
 * the scroll position moves by the same amount so what they are reading does
 * not jump. All of that happens in the ResizeObserver callback, after layout
 * and before paint, so no frame shows the intermediate state.
 *
 * A pane kept mounted out of sight keeps its layout (the workspace view hides
 * it with content-visibility), so it comes back where it was left. If it is
 * ever hidden with display:none instead, it measures as zero: those readings
 * are ignored, and the scroll position is put back when it is shown again.
 */

/**
 * The gap after a row, matching the `space-y-5` the transcript column used
 * when every part of every message was one flat list of siblings. A row may
 * ask for less (`gapAfter`): a PR card's own 8 px margin used to win over the
 * list's, and rows reproduce that rather than re-spacing the transcript.
 */
export const ROW_GAP = 20;

export interface VirtualRow {
  key: string;
  /** Space after this row when another follows it (default ROW_GAP). */
  gapAfter?: number;
}
/** Rows kept rendered past each edge of the viewport, in pixels. */
const OVERSCAN = 500;
/** Chats whose row heights are kept once their pane is gone. */
const HEIGHT_CACHES = 12;

const heightCaches = new Map<string, Map<string, number>>();

function heightsFor(cacheKey: string): Map<string, number> {
  let m = heightCaches.get(cacheKey);
  if (m) heightCaches.delete(cacheKey);
  else m = new Map();
  heightCaches.set(cacheKey, m);
  while (heightCaches.size > HEIGHT_CACHES) heightCaches.delete(heightCaches.keys().next().value!);
  return m;
}

export interface VirtualTranscriptHandle {
  /** Follow the bottom again and go there. */
  scrollToBottom(behavior?: ScrollBehavior): void;
  /** Bring a row to the top of the viewport, rendering it first if it is far away. */
  scrollToKey(key: string, behavior?: ScrollBehavior): void;
  /** Move the view by `delta` pixels and stop following the bottom (find-in-chat centring a match). */
  scrollByPx(delta: number): void;
}

export interface VirtualTranscriptProps<R extends VirtualRow> {
  rows: readonly R[];
  /** Must be stable across renders that don't change what rows look like. */
  renderRow: (row: R) => React.ReactNode;
  /** Height in pixels (gap included) for a row that has not been measured yet. */
  estimate: (row: R) => number;
  /** Which chat these rows belong to, for the height cache. */
  cacheKey: string;
  /** Classes of the content column (width, gap between children). */
  className: string;
  /** Rendered above the rows (the empty state). */
  header?: React.ReactNode;
  /** Rendered below the rows: the live turn and the status lines. */
  footer?: React.ReactNode;
  onPinnedChange?: (pinned: boolean) => void;
  /** The conversation grew at the bottom while the reader was scrolled up. */
  onGrowWhileUnpinned?: () => void;
  /** A row's time, shown when the reader swipes the transcript left. */
  stampOf?: (row: R) => string | undefined;
  ref?: React.Ref<VirtualTranscriptHandle>;
}

/** Room for a full localized time plus its gap, including AM/PM. */
const REVEAL_PX = 112;
/** No horizontal wheel input for this long means the fingers left the trackpad. */
const REVEAL_RELEASE_MS = 120;

/**
 * Swipe horizontally on the trackpad to see when each row was sent, as chat apps do:
 * either direction slides the whole row left, then springs back on release. Driven
 * through CSS variables on the scroller, so a swipe re-renders nothing.
 */
function useSwipeToRevealTimes(scrollRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let reveal = 0;
    let release: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const paint = (px: number) => {
      el.style.setProperty('--vt-reveal', `${px}px`);
      el.style.setProperty('--vt-reveal-o', String(px / REVEAL_PX));
      // Only while moved: a transform at rest would trap fixed popovers in rows.
      el.classList.toggle('vt-revealing', px > 0);
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      clearTimeout(release);
      clearTimeout(settle);
      el.classList.add('vt-swiping');
      reveal = Math.min(REVEAL_PX, Math.max(0, reveal + Math.abs(e.deltaX)));
      paint(reveal);
      release = setTimeout(() => {
        el.classList.remove('vt-swiping');
        reveal = 0;
        el.style.setProperty('--vt-reveal-o', '0');
        el.style.setProperty('--vt-reveal', '0px');
        settle = setTimeout(() => paint(0), 250);
      }, REVEAL_RELEASE_MS);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(release); clearTimeout(settle); };
  }, [scrollRef]);
}

function VirtualTranscriptImpl<R extends VirtualRow>({
  rows, renderRow, estimate, cacheKey, className, header, footer, onPinnedChange, onGrowWhileUnpinned, stampOf, ref,
}: VirtualTranscriptProps<R>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const heights = useMemo(() => heightsFor(cacheKey), [cacheKey]);
  const memory = useMemo(() => new Map<string, unknown>(), [cacheKey]);
  const [measured, setMeasured] = useState(0);
  const [, setWindowTick] = useState(0);

  const pinned = useRef(true);
  const hidden = useRef(false);
  const savedTop = useRef(0);
  /** Where the list was last left, by the reader or by us, to tell a scroll up from content moving. */
  const lastTop = useRef(0);
  const contentHeight = useRef(0);
  /** The viewport in list coordinates, as last read from the DOM. */
  const view = useRef({ top: 0, height: typeof window === 'undefined' ? 800 : window.innerHeight });

  const offsets = useMemo(
    () => prefixOffsets(rows.length, (i) => heights.get(rows[i].key) ?? estimate(rows[i])),
    // `measured` is the signal that `heights` (a mutable cache) changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, heights, estimate, measured],
  );
  const total = offsets[rows.length] ?? 0;

  const rangeNow = (o: Float64Array): RowRange =>
    pinned.current
      ? bottomRange(o, view.current.height, OVERSCAN)
      : rangeFor(o, view.current.top, view.current.top + view.current.height, OVERSCAN);

  const range = rangeNow(offsets);
  const latest = useRef({ offsets, range, rows, onPinnedChange, onGrowWhileUnpinned });
  latest.current = { offsets, range, rows, onPinnedChange, onGrowWhileUnpinned };

  /** Read the viewport off the DOM. */
  const syncView = useCallback(() => {
    const sc = scrollRef.current;
    const list = listRef.current;
    if (!sc) return;
    const listTop = list ? list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop : 0;
    view.current = { top: sc.scrollTop - listTop, height: sc.clientHeight };
  }, []);

  const setPinned = useCallback((next: boolean) => {
    if (pinned.current === next) return;
    pinned.current = next;
    latest.current.onPinnedChange?.(next);
  }, []);

  /** Re-render now if the rows on screen are no longer the ones rendered. */
  const refreshWindow = useCallback((sync: boolean) => {
    const { offsets: o, range: r } = latest.current;
    const next = pinned.current
      ? bottomRange(o, view.current.height, OVERSCAN)
      : rangeFor(o, view.current.top, view.current.top + view.current.height, OVERSCAN);
    if (sameRange(next, r)) return;
    if (sync) flushSync(() => setWindowTick((t) => t + 1));
    else setWindowTick((t) => t + 1);
  }, []);

  const stickToBottom = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    sc.scrollTop = sc.scrollHeight;
    lastTop.current = sc.scrollTop;
  };

  /** What the shared ResizeObserver does with a batch of size changes. */
  const onResize = (entries: ResizeObserverEntry[]) => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (sc.clientHeight === 0) {
      hidden.current = true;
      return;
    }
    if (hidden.current) {
      // Shown again: display:none dropped the scroll offset.
      hidden.current = false;
      sc.scrollTop = pinned.current ? sc.scrollHeight : savedTop.current;
    }
    const scTop = sc.getBoundingClientRect().top;
    const changes: Array<{ top: number; bottom: number; delta: number }> = [];
    let grew = false;
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      if (el === sc) continue;
      if (el === contentRef.current) {
        const h = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
        grew = h > contentHeight.current + 0.5;
        contentHeight.current = h;
        continue;
      }
      const key = el.dataset.vtKey;
      if (!key) continue;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
      const { rows: rs } = latest.current;
      const old = heights.get(key) ?? (() => {
        const row = rs.find((r) => r.key === key);
        return row ? estimate(row) : h;
      })();
      if (Math.abs(h - old) < 0.5) continue;
      heights.set(key, h);
      const rect = el.getBoundingClientRect();
      changes.push({ top: rect.top - scTop, bottom: rect.bottom - scTop, delta: h - old });
    }

    if (pinned.current) {
      stickToBottom();
    } else if (changes.length) {
      // Where each changed row ended before this layout, top to bottom.
      changes.sort((a, b) => a.top - b.top);
      let cumulative = 0;
      const before = changes.map((c) => {
        cumulative += c.delta;
        return { oldBottom: c.bottom - cumulative, delta: c.delta };
      });
      const shift = shiftAbove(before, 0);
      if (shift) {
        sc.scrollTop += shift;
        lastTop.current = sc.scrollTop;
      }
    }
    // Growth with no row changing size is the live turn (or a new row).
    if (grew && !pinned.current && changes.length === 0) latest.current.onGrowWhileUnpinned?.();

    savedTop.current = sc.scrollTop;
    syncView();
    if (changes.length) flushSync(() => setMeasured((m) => m + 1));
    else refreshWindow(true);
  };
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  // One observer for the scroller, the column and every rendered row. Rows
  // register as they mount (before this effect runs on the first commit), so
  // the observer picks up whatever is already there when it is created.
  const observer = useRef<ResizeObserver | null>(null);
  const rowEls = useRef(new Set<HTMLElement>());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => onResizeRef.current(entries));
    observer.current = ro;
    if (scrollRef.current) ro.observe(scrollRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    for (const el of rowEls.current) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, []);

  // First paint lands on the newest messages. Set in the frame's own
  // animation-frame step rather than here: moving the scroll position needs a
  // layout, and forcing one now would lay the pane out twice before it paints.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      if (pinned.current) stickToBottom();
      syncView();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const onScroll = () => {
    const sc = scrollRef.current;
    if (!sc || sc.clientHeight === 0) return;
    // Only the reader scrolling up lets go of the bottom. Content growing or
    // being re-measured above (an estimate corrected) also puts the bottom
    // further away, but that is not a reason to stop following it.
    const up = sc.scrollTop < lastTop.current - 1;
    lastTop.current = sc.scrollTop;
    if (pinned.current && !up) {
      if (!isPinned(sc.scrollHeight, sc.scrollTop, sc.clientHeight)) stickToBottom();
    } else {
      setPinned(isPinned(sc.scrollHeight, sc.scrollTop, sc.clientHeight));
    }
    savedTop.current = sc.scrollTop;
    syncView();
    refreshWindow(true);
  };

  useImperativeHandle(ref, () => ({
    scrollToBottom(behavior: ScrollBehavior = 'auto') {
      const sc = scrollRef.current;
      if (!sc) return;
      setPinned(true);
      sc.scrollTo({ top: sc.scrollHeight, behavior });
    },
    scrollToKey(key: string, behavior: ScrollBehavior = 'auto') {
      const sc = scrollRef.current;
      const list = listRef.current;
      const { rows: rs, offsets: o } = latest.current;
      const i = rs.findIndex((r) => r.key === key);
      if (!sc || !list || i < 0) return;
      setPinned(false);
      const listTop = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTo({ top: listTop + o[i], behavior });
    },
    scrollByPx(delta: number) {
      const sc = scrollRef.current;
      if (!sc || !delta) return;
      // Unpinned first, or the next size change snaps the view back down.
      setPinned(sc.scrollHeight - (sc.scrollTop + delta) - sc.clientHeight < 1);
      sc.scrollTop += delta;
      lastTop.current = sc.scrollTop;
    },
  }), [setPinned]);

  const observe = useCallback((el: HTMLElement) => {
    rowEls.current.add(el);
    observer.current?.observe(el);
    return () => {
      rowEls.current.delete(el);
      observer.current?.unobserve(el);
    };
  }, []);

  useSwipeToRevealTimes(scrollRef);

  const visible = rows.slice(range.start, range.end);
  const tailGap = rows[rows.length - 1]?.gapAfter;
  return (
    <div
      ref={scrollRef}
      data-transcript-scroll
      onScroll={onScroll}
      className="mr-1 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-[30px] py-5"
      style={{ overflowAnchor: 'none' }}
    >
      <div ref={contentRef} className={className}>
        {header}
        {rows.length > 0 && (
          <RowMemoryContext.Provider value={memory}>
            <div
              ref={listRef}
              className="vt-list"
              style={{
                paddingTop: offsets[range.start],
                paddingBottom: Math.max(0, total - offsets[range.end]),
                // The column's own gap applies after the list; only a smaller one needs saying.
                ...(tailGap != null && tailGap !== ROW_GAP ? { marginBottom: tailGap } : {}),
              }}
            >
              {visible.map((row, k) => (
                <Row
                  key={row.key}
                  row={row}
                  renderRow={renderRow}
                  last={range.start + k === rows.length - 1}
                  stamp={stampOf?.(row)}
                  observe={observe}
                />
              ))}
            </div>
          </RowMemoryContext.Provider>
        )}
        {footer}
      </div>
    </div>
  );
}

interface RowProps<R extends VirtualRow> {
  row: R;
  renderRow: (row: R) => React.ReactNode;
  last: boolean;
  stamp?: string;
  observe: (el: HTMLElement) => () => void;
}

function RowImpl<R extends VirtualRow>({ row, renderRow, last, stamp, observe }: RowProps<R>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? observe(ref.current) : undefined), [observe]);
  return (
    <div ref={ref} data-vt-key={row.key} data-vt-stamp={stamp || undefined} className="vt-row space-y-5" style={last ? undefined : { paddingBottom: row.gapAfter ?? ROW_GAP }}>
      <RowKeyContext.Provider value={row.key}>{renderRow(row)}</RowKeyContext.Provider>
    </div>
  );
}

const Row = memo(RowImpl) as typeof RowImpl;

export const VirtualTranscript = memo(VirtualTranscriptImpl) as typeof VirtualTranscriptImpl;
