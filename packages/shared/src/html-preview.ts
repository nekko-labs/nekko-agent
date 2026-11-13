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
  /**
   * Add the viewer's control script to the page, so the design canvas can ask
   * its size and pause or resume its motion over `postMessage`. Off by default.
   */
  controls?: boolean;
}

/**
 * What the design canvas asks a served page, as `{ nekkoPreview: <command> }`.
 * `targets` starts reporting where the clickable parts are (again whenever the
 * page changes) and `untargets` stops it.
 */
export type PreviewCommand = 'probe' | 'pause' | 'play' | 'targets' | 'untargets';

/** A served page's answer to a `PreviewCommand`, and its report once loaded. */
export interface PreviewState {
  nekkoPreview: 'state';
  /** Running or paused CSS animations, transitions and Web Animations. */
  animations: number;
  /** `<video>` and `<audio>` elements. */
  media: number;
  /** `requestAnimationFrame` calls so far: a loop makes this climb. */
  frames: number;
  paused: boolean;
  /** The page's full scroll size, in CSS pixels. */
  width: number;
  height: number;
}

/**
 * A scroll or pinch over the design that the page had no use for, passed up so
 * the canvas moves (or zooms, when `zoom`) as it would over its own surface.
 * `x`/`y` are where the pointer is in the page, in its own CSS pixels.
 */
export interface PreviewWheel {
  nekkoPreview: 'wheel';
  dx: number;
  dy: number;
  x: number;
  y: number;
  zoom: boolean;
}

/**
 * Where the design's clickable parts are (links, buttons, fields, anything with a
 * pointer cursor), as `[x, y, width, height]` boxes in the page's own CSS pixels.
 */
export interface PreviewTargets {
  nekkoPreview: 'targets';
  boxes: Array<[number, number, number, number]>;
}

/** Space pressed or let go inside the design: while it is down the canvas drags. */
export interface PreviewHand {
  nekkoPreview: 'hand';
  down: boolean;
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
