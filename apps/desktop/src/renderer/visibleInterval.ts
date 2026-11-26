import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usePaneVisible } from './paneVisibility.js';

/**
 * Timers that only run while somebody can see what they update.
 *
 * `useVisibleInterval` is a `setInterval` that pauses while the window is
 * hidden (`document.hidden`: minimised, in the tray, another desktop) and
 * while the pane it lives in is parked (`usePaneVisible`), and reads once at
 * once when it resumes, so a pane shown again is current without waiting a
 * full period. `useSharedTick` is the same for a clock: every subscriber rides
 * one timer.
 */

function subscribeDocumentVisible(fn: () => void): () => void {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
}

/** Whether the window is visible, re-rendering the caller when that changes. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocumentVisible, () => !document.hidden, () => true);
}

export interface VisibleIntervalOptions {
  /** Also run once when the effect starts (mount, `deps` change), if visible. */
  immediate?: boolean;
  /** Restart the timer (and run it, with `immediate`) when these change. */
  deps?: readonly unknown[];
}

/**
 * Run `fn` every `ms` while the window and the pane are visible. `ms` null turns
 * it off. `fn` is read fresh on every tick, so it may close over current state,
 * and receives `live`, which turns false once this run of the timer is cleaned
 * up (guard a late promise with it). Resuming after a pause runs `fn` at once.
 */
export function useVisibleInterval(fn: (live: () => boolean) => void, ms: number | null, options: VisibleIntervalOptions = {}): void {
  const { immediate = false, deps = [] } = options;
  const paneVisible = usePaneVisible();
  const windowVisible = useDocumentVisible();
  const on = ms !== null && paneVisible && windowVisible;
  const latest = useRef(fn);
  latest.current = fn;
  const paused = useRef(false);
  useEffect(() => {
    if (!on) { paused.current = ms !== null; return; }
    let alive = true;
    const run = () => latest.current(() => alive);
    if (immediate || paused.current) run();
    paused.current = false;
    const timer = setInterval(run, ms);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, ms, immediate, ...deps]);
}

/* One shared ticker: a clock that many components show (every limits chip, a
   watch's countdown) needs one timer, not one per component. */
const tickers = new Map<number, { fns: Set<() => void>; timer: ReturnType<typeof setInterval> | null }>();

function startTicker(ms: number, t: { fns: Set<() => void>; timer: ReturnType<typeof setInterval> | null }) {
  if (t.timer || !t.fns.size || (typeof document !== 'undefined' && document.hidden)) return;
  t.timer = setInterval(() => { for (const fn of [...t.fns]) fn(); }, ms);
}

function onVisibility() {
  for (const [ms, t] of tickers) {
    if (document.hidden) { if (t.timer) { clearInterval(t.timer); t.timer = null; } continue; }
    if (t.fns.size && !t.timer) { startTicker(ms, t); for (const fn of [...t.fns]) fn(); }
  }
}

/** Subscribe to the shared ticker for `ms`; returns the unsubscribe. */
export function subscribeTick(ms: number, fn: () => void): () => void {
  let t = tickers.get(ms);
  if (!t) {
    t = { fns: new Set(), timer: null };
    tickers.set(ms, t);
    if (tickers.size === 1 && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  }
  t.fns.add(fn);
  startTicker(ms, t);
  return () => {
    t.fns.delete(fn);
    if (t.fns.size) return;
    if (t.timer) clearInterval(t.timer);
    tickers.delete(ms);
    if (!tickers.size && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** How many shared tickers have a live timer, for tests. */
export function runningTickers(): number {
  return [...tickers.values()].filter((t) => t.timer).length;
}

/**
 * Call `fn` every `ms` on the shared ticker while `enabled` and the pane is
 * visible. The window being hidden pauses the ticker itself.
 */
export function useSharedTick(fn: () => void, ms = 1000, enabled = true): void {
  const on = enabled && usePaneVisible();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => (on ? subscribeTick(ms, () => latest.current()) : undefined), [on, ms]);
}
