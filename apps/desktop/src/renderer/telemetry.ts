import { useStore } from './store.js';
import clickLabelList from './clickLabels.json';

/** Fixed control names a click may report (scripts/click-labels.mjs). */
const CLICK_LABELS = new Set<string>(clickLabelList);

/**
 * The name a click reports: the nearest control's data-testid or aria-label,
 * only when that is fixed text from the source. A label built from a file,
 * chat or person's name is not in the list, so the click is not reported.
 */
export function clickControl(target: EventTarget | null): string | null {
  const el = typeof (target as Element | null)?.closest === 'function' ? (target as Element).closest('[data-testid],[aria-label]') : null;
  const name = el?.getAttribute('data-testid') ?? el?.getAttribute('aria-label');
  return name && CLICK_LABELS.has(name) ? name : null;
}

/**
 * An error as a report starts out: its class and message (the engine keeps
 * only the first line, 200 characters at most) and its stack (the engine keeps
 * only function and file names).
 */
export function errorReport(err: unknown, source = 'renderer'): { source: string; message: string; stack: string } {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
  const message = String(e?.message ?? err ?? '');
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  return { source, message: `${name}: ${message}`, stack: String(e?.stack ?? '') };
}

/**
 * Browser notices that arrive as window errors but are not faults, so they are
 * not reported. Chromium raises "ResizeObserver loop completed with
 * undelivered notifications" when a resize callback changes layout and the
 * rest is delivered next frame; nothing is lost. It was over 98% of all error
 * reports in November 2026.
 */
export function ignoredError(message: unknown): boolean {
  return typeof message === 'string' && /^(?:[A-Za-z]*Error: )?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(message);
}

/**
 * Queue one opt-in report, only while reports are on. The engine also drops it
 * when they are off, keeps only the event's allowed fields and scrubs every
 * string (crates/nekkod/src/telemetry.rs).
 */
export function capture(event: 'screen_viewed' | 'click' | 'feedback_opened' | 'error', props: Record<string, string>): void {
  if (useStore.getState().settings?.telemetry?.enabled !== true) return;
  void window.nekko.telemetryCapture?.(event, props).catch(() => {});
}

/**
 * Opt-in reports from the UI: which screen is open, which controls are
 * clicked, and uncaught errors.
 */
export function startTelemetry(): void {
  let last = useStore.getState().view;
  useStore.subscribe((s) => {
    if (s.view === last) return;
    last = s.view;
    capture('screen_viewed', { screen: s.view });
  });
  document.addEventListener('click', (e) => {
    const control = clickControl(e.target);
    if (control) capture('click', { screen: useStore.getState().view, control });
  }, { capture: true, passive: true });
  window.addEventListener('error', (e) => { if (!ignoredError(e.message)) capture('error', errorReport(e.error ?? e.message)); });
  window.addEventListener('unhandledrejection', (e) => capture('error', errorReport(e.reason)));
}
