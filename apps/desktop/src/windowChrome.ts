/**
 * The window-chrome contract, shared by main and preload.
 *
 * Nekko Agent draws its own title bar: one strip carrying the wordmark, with the
 * OS buttons sitting in the same line and the same colour as the app behind
 * them. That needs two things crossing the process boundary — the platform, so
 * the renderer knows which side to leave clear, and the theme colours, so the
 * native buttons repaint when the app goes light or dark.
 *
 * Deliberately not part of `IpcChannels`: everything there is routed through
 * the shared Host dispatcher and reimplemented by the web transport, and a
 * browser tab has no window chrome to speak of.
 */

/**
 * Height of the title strip, in CSS pixels.
 *
 * The same number on both sides: the renderer sizes the strip with it and the
 * main process gives the Window Controls Overlay the same height, so the
 * buttons land on the wordmark's line rather than floating above or below it.
 */
// The native caption buttons keep this 38px band. The app's strip is taller
// (46px in styles.css, mark centred at 29px) for breathing room, and its trailing toolbar sits on
// this band's bottom edge so it lines up with the buttons.
export const TITLEBAR_HEIGHT = 38;

/** Renderer → main, fire-and-forget: repaint the native buttons for a theme. */
export const TITLEBAR_OVERLAY_CHANNEL = 'chrome:titlebar-overlay';

export interface TitleBarOverlayTheme {
  /** Background behind the native minimise/maximise/close buttons. */
  color: string;
  /** The glyphs themselves. */
  symbolColor: string;
}

/** What the preload bridge exposes as `window.nekkoChrome`. */
export interface WindowChromeBridge {
  /** `process.platform`; the renderer only cares whether it is `'darwin'`. */
  serviceControl: (action: import('./engineChannels.js').ServiceAction) => Promise<import('./engineChannels.js').ServiceStatus>;
  reportNotificationVisibility: (report: import('./notificationVisibility.js').NotificationVisibilityReport) => void;
  platform: string;
  titleBarHeight: number;
  setTitleBarOverlay: (theme: TitleBarOverlayTheme) => void;
}
