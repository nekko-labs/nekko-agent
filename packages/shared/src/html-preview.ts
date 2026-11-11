/**
 * A local HTML page served with its folder, so a design that links its own
 * CSS, scripts, images and fonts renders as it would in a browser. The host
 * (the desktop app's main process, or the Local Web UI server) serves it;
 * the renderer only asks for a page and shows the URL it gets back. The
 * server itself is `@nekko-agent/profile/html-preview`.
 */

/** Channels the host answers itself; they never reach the engine. */
export const HTML_PREVIEW_CHANNELS = {
  serve: 'htmlPreview:serve',
  release: 'htmlPreview:release',
} as const;

export interface HtmlPreviewOptions {
  /** Let the page load from the internet (https and wss only). Off by default. */
  internet: boolean;
}

export interface HtmlPreviewServed {
  /** Hand back to `release` when the preview closes. */
  id: string;
  /** Where the page is, with a secret path only this preview knows. */
  url: string;
}

/** Pages the host will serve with their folder. */
export function isServableHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}
