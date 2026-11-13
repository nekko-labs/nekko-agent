import type { PreviewState } from '@nekko-agent/shared';

/**
 * The arithmetic of the design canvas, kept apart from the component so it can
 * be tested without a window: how big the design's frame is, where it sits,
 * and whether the design is moving.
 */

export interface CanvasSize { width: number; height: number }
/** Where the frame's top-left corner sits in the canvas, and its scale. */
export interface CanvasView { z: number; x: number; y: number }

/** The frame a design is first laid out in, before it reports its own size: a desktop window. */
export const FRAME: CanvasSize = { width: 1440, height: 900 };
/** A design is shown whole up to this size; a longer or wider one is cut off here. */
export const FRAME_MAX: CanvasSize = { width: 8000, height: 12000 };
export const ZOOM = { min: 0.1, max: 4, step: 1.25 };
/** Clear space around a fitted design. */
export const MARGIN = 24;
/** `requestAnimationFrame` calls between two looks that mean a loop is running, not a one-off. */
const LOOP_FRAMES = 20;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** A served page's report, or null for anything else a frame may post (the page is untrusted). */
export function readPreviewState(data: unknown): PreviewState | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.nekkoPreview !== 'state') return null;
  const [animations, media, frames, width, height] = [d.animations, d.media, d.frames, d.width, d.height].map(count);
  if (animations === null || media === null || frames === null || width === null || height === null) return null;
  return { nekkoPreview: 'state', animations, media, frames, paused: d.paused === true, width, height };
}

/** The frame that shows the whole design: at least a desktop window, at most `FRAME_MAX`. */
export function frameSize(state: Pick<PreviewState, 'width' | 'height'>): CanvasSize {
  return { width: clamp(state.width, FRAME.width, FRAME_MAX.width), height: clamp(state.height, FRAME.height, FRAME_MAX.height) };
}

/** The whole width in view, centred, from the top; never larger than life. */
export function fitView(canvas: CanvasSize, frame: CanvasSize): CanvasView {
  const z = clamp((canvas.width - MARGIN * 2) / frame.width, ZOOM.min, 1);
  return { z, x: Math.round((canvas.width - frame.width * z) / 2), y: MARGIN };
}

/** Zoom by `factor`, keeping the point under the pointer where it is. */
export function zoomAt(view: CanvasView, factor: number, point: { x: number; y: number }): CanvasView {
  const z = clamp(view.z * factor, ZOOM.min, ZOOM.max);
  const k = z / view.z;
  return { z, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k };
}

/**
 * Is the design moving? An animation, a video or a sound says yes at once; a
 * script-driven one shows as a run of animation frames since the last look.
 */
export function isAnimating(previous: PreviewState | null, now: PreviewState): boolean {
  if (now.animations > 0 || now.media > 0) return true;
  return !!previous && now.frames - previous.frames >= LOOP_FRAMES;
}
