import { useStore } from './store.js';

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
  window.addEventListener('error', (e) => send('error', { source: 'renderer', message: String(e.message ?? ''), stack: String(e.error?.stack ?? '') }));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
    send('error', { source: 'renderer', message: String(r?.message ?? r ?? ''), stack: String(r?.stack ?? '') });
  });
}
