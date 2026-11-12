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
 * Opt-in reports from the UI: which screen is open, which controls are
 * clicked, and uncaught errors. The engine drops them unless reports are on,
 * keeps only the allowed fields and scrubs every string
 * (crates/nekkod/src/telemetry.rs).
 */
export function startTelemetry(): void {
  const send = (event: 'screen_viewed' | 'click' | 'error', props: Record<string, string>) => {
    if (useStore.getState().settings?.telemetry?.enabled !== true) return;
    void window.nekko.telemetryCapture?.(event, props).catch(() => {});
  };
  let last = useStore.getState().view;
  useStore.subscribe((s) => {
    if (s.view === last) return;
    last = s.view;
    send('screen_viewed', { screen: s.view });
  });
  document.addEventListener('click', (e) => {
    const control = clickControl(e.target);
    if (control) send('click', { screen: useStore.getState().view, control });
  }, { capture: true, passive: true });
  window.addEventListener('error', (e) => send('error', errorReport(e.error ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => send('error', errorReport(e.reason)));
}
