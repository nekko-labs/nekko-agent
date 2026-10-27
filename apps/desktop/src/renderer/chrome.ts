/**
 * The renderer's half of the window chrome.
 *
 * Nekko Agent draws its own title bar so the OS buttons sit on the same line, in
 * the same colour, as the app behind them. Only the desktop shell has one:
 * `window.nekkoChrome` is exposed by the Electron preload and is simply
 * absent in a browser tab or a Capacitor build, which is how everything here
 * knows to do nothing.
 *
 * The bridge's own shape lives in `src/windowChrome.ts`, shared with main and
 * preload; the renderer builds from a different Vite root and only needs the
 * two members it actually calls, so it reads them off the global instead of
 * importing across the root boundary.
 */

interface WindowChrome {
  serviceControl: (action: import('../engineChannels.js').ServiceAction) => Promise<import('../engineChannels.js').ServiceStatus>;
  platform: string;
  titleBarHeight: number;
  setTitleBarOverlay: (theme: { color: string; symbolColor: string }) => void;
}

/** The bridge, or `undefined` when this isn't the desktop shell. */
export const windowChrome: WindowChrome | undefined = typeof window === 'undefined' ? undefined : (
  window as unknown as { nekkoChrome?: WindowChrome }
).nekkoChrome;

/** Whether the app is responsible for drawing its own title bar. */
export const hasAppChrome = Boolean(windowChrome);

/** macOS keeps its native traffic lights, so the strip's *left* end is spoken for. */
export const isMacChrome = windowChrome?.platform === 'darwin';

/**
 * Repaint the native buttons to match the theme that is on screen right now.
 *
 * Called from `applyTheme`, because the theme is the renderer's to resolve
 * ("system" depends on a media query the main process isn't watching) and the
 * colours come from CSS custom properties that only exist here.
 */
export function syncTitleBarOverlay(): void {
  if (!windowChrome) return;
  const css = getComputedStyle(document.documentElement);
  // A theme whose title bar shows the field behind it sets its own overlay colour.
  const color = (css.getPropertyValue('--titlebar-overlay') || css.getPropertyValue('--paper')).trim();
  const symbolColor = css.getPropertyValue('--ink-soft').trim();
  if (color && symbolColor) windowChrome.setTitleBarOverlay({ color, symbolColor });
}
