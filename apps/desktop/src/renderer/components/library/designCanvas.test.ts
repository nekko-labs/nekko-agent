import { describe, expect, it } from 'vitest';
import { FRAME, FRAME_MAX, MARGIN, ZOOM, fitView, frameSize, isAnimating, readPreviewState, zoomAt } from './designCanvasView.js';

const state = (over: Record<string, unknown> = {}) => ({ nekkoPreview: 'state', animations: 0, media: 0, frames: 0, paused: false, width: 1440, height: 900, ...over });

describe('design canvas view', () => {
  it('reads a page report and refuses anything else a frame may post', () => {
    expect(readPreviewState(state({ animations: 2.9, paused: true }))).toEqual({ nekkoPreview: 'state', animations: 2, media: 0, frames: 0, paused: true, width: 1440, height: 900 });
    // A truthy value is not a pause, and extra fields are dropped.
    expect(readPreviewState(state({ paused: 'yes', html: '<script>' }))).toEqual({ nekkoPreview: 'state', animations: 0, media: 0, frames: 0, paused: false, width: 1440, height: 900 });
    for (const bad of [null, 'state', 7, {}, { nekkoPreview: 'pause' }, state({ width: '1440' }), state({ height: -1 }), state({ frames: Infinity }), state({ media: NaN })]) expect(readPreviewState(bad)).toBeNull();
  });

  it('gives the design a frame that shows all of it, within bounds', () => {
    expect(frameSize({ width: 300, height: 200 })).toEqual(FRAME);
    expect(frameSize({ width: 5200, height: 2700 })).toEqual({ width: 5200, height: 2700 });
    expect(frameSize({ width: 1e9, height: 1e9 })).toEqual(FRAME_MAX);
  });

  it('fits the whole width, centred from the top, and never larger than life', () => {
    expect(fitView({ width: 1000, height: 700 }, { width: 1440, height: 900 })).toEqual({ z: (1000 - MARGIN * 2) / 1440, x: MARGIN, y: MARGIN });
    // A design narrower than the canvas stays at 100%, centred.
    expect(fitView({ width: 2000, height: 700 }, { width: 1440, height: 900 })).toEqual({ z: 1, x: 280, y: MARGIN });
    // A very wide one stops at the smallest zoom.
    expect(fitView({ width: 400, height: 700 }, { width: 8000, height: 900 }).z).toBe(ZOOM.min);
  });

  it('zooms around the pointer and stops at its limits', () => {
    const view = { z: 0.5, x: 100, y: 40 };
    const point = { x: 300, y: 240 };
    const zoomed = zoomAt(view, 2, point);
    expect(zoomed.z).toBe(1);
    // The design point under the pointer is the same before and after.
    expect((point.x - zoomed.x) / zoomed.z).toBeCloseTo((point.x - view.x) / view.z);
    expect((point.y - zoomed.y) / zoomed.z).toBeCloseTo((point.y - view.y) / view.z);
    expect(zoomAt(view, 100, point).z).toBe(ZOOM.max);
    expect(zoomAt(view, 0.001, point).z).toBe(ZOOM.min);
  });

  it('calls a design moving for an animation, media or a frame loop, not a one-off frame', () => {
    const still = readPreviewState(state())!;
    expect(isAnimating(null, still)).toBe(false);
    expect(isAnimating(null, readPreviewState(state({ animations: 1 }))!)).toBe(true);
    expect(isAnimating(null, readPreviewState(state({ media: 1 }))!)).toBe(true);
    // A script that asked for a few frames while loading is not a loop; sixty a second is.
    expect(isAnimating(still, readPreviewState(state({ frames: 5 }))!)).toBe(false);
    expect(isAnimating(still, readPreviewState(state({ frames: 60 }))!)).toBe(true);
    expect(isAnimating(null, readPreviewState(state({ frames: 600 }))!)).toBe(false);
  });
});
