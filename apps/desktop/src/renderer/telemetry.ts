import { useStore } from './store.js';

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
 * Opt-in reports from the UI: which screen is open, and uncaught errors. The
 * engine drops them unless reports are on, keeps only the allowed fields and
 * scrubs every string (crates/nekkod/src/telemetry.rs).
 */
export function startTelemetry(): void {
  const send = (event: 'screen_viewed' | 'error', props: Record<string, string>) => {
    if (useStore.getState().settings?.telemetry?.enabled !== true) return;
    void window.nekko.telemetryCapture?.(event, props).catch(() => {});
  };
  let last = useStore.getState().view;
  useStore.subscribe((s) => {
    if (s.view === last) return;
    last = s.view;
    send('screen_viewed', { screen: s.view });
  });
  window.addEventListener('error', (e) => send('error', errorReport(e.error ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => send('error', errorReport(e.reason)));
}
