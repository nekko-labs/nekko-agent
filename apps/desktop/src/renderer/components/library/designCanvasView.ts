import type { PreviewState, PreviewTargets, PreviewWheel } from '@nekko-agent/shared';

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

/** The largest single scroll step a page may pass up, in CSS pixels: a hostile page can nudge the view, not fling it. */
export const WHEEL_MAX = 400;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A scroll or pinch the page passed up, or null for anything else. Steps are
 * capped and the pointer is held inside the frame, since the page is untrusted.
 */
export function readPreviewWheel(data: unknown, frame: CanvasSize): PreviewWheel | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.nekkoPreview !== 'wheel' || !finite(d.dx) || !finite(d.dy) || !finite(d.x) || !finite(d.y)) return null;
  return {
    nekkoPreview: 'wheel',
    dx: clamp(d.dx, -WHEEL_MAX, WHEEL_MAX),
    dy: clamp(d.dy, -WHEEL_MAX, WHEEL_MAX),
    x: clamp(d.x, 0, frame.width),
    y: clamp(d.y, 0, frame.height),
    zoom: d.zoom === true,
  };
}

/** Space pressed (true) or let go (false) in the page, or null for anything else. */
export function readPreviewHand(data: unknown): boolean | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return d.nekkoPreview === 'hand' && typeof d.down === 'boolean' ? d.down : null;
}

/** How far a scroll step zooms: the same for the canvas's own wheel and one passed up by the page. */
export const wheelZoom = (deltaY: number) => Math.exp(-deltaY * 0.0015);

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

/** The most clickable parts the canvas will outline: more is noise, and the page is untrusted. */
export const TARGETS_MAX = 400;

/**
 * Where a page says its clickable parts are, or null for anything else. Each box
 * must be four finite numbers; it is cut to the frame and dropped when nothing
 * of it is left, so a hostile page can only draw outlines over its own design.
 */
export function readPreviewTargets(data: unknown, frame: CanvasSize): PreviewTargets['boxes'] | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.nekkoPreview !== 'targets' || !Array.isArray(d.boxes)) return null;
  const boxes: PreviewTargets['boxes'] = [];
  for (const b of d.boxes.slice(0, TARGETS_MAX)) {
    if (!Array.isArray(b) || b.length !== 4 || !b.every(finite)) continue;
    const [x, y, w, h] = b as number[];
    const left = clamp(x, 0, frame.width), top = clamp(y, 0, frame.height);
    const right = clamp(x + w, 0, frame.width), bottom = clamp(y + h, 0, frame.height);
    if (right - left >= 1 && bottom - top >= 1) boxes.push([left, top, right - left, bottom - top]);
  }
  return boxes;
}

/** How far an arrow key moves the canvas, in screen pixels; Shift moves further. */
export const KEY_STEP = { near: 60, far: 300 };

/**
 * What a key does on the canvas: arrows move it, + and - zoom at the middle,
 * 0 fits the design and 1 shows it at 100%. Null for any other key, and for
 * any key with Ctrl, Cmd or Alt, which belong to the app.
 */
export function keyAction(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  view: CanvasView,
  canvas: CanvasSize,
): CanvasView | 'fit' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const step = e.shiftKey ? KEY_STEP.far : KEY_STEP.near;
  const middle = { x: canvas.width / 2, y: canvas.height / 2 };
  switch (e.key) {
    case 'ArrowLeft': return { ...view, x: view.x + step };
    case 'ArrowRight': return { ...view, x: view.x - step };
    case 'ArrowUp': return { ...view, y: view.y + step };
    case 'ArrowDown': return { ...view, y: view.y - step };
    case '+': case '=': return zoomAt(view, ZOOM.step, middle);
    case '-': case '_': return zoomAt(view, 1 / ZOOM.step, middle);
    case '0': return 'fit';
    case '1': return zoomAt(view, 1 / view.z, middle);
    default: return null;
  }
}

/** The dotted surface's spacing at this zoom: it moves with the design, kept between 12 and 36 pixels. */
export function dotSpacing(z: number): number {
  let s = 18 * z;
  while (s < 12) s *= 2;
  while (s > 36) s /= 2;
  return s;
}
