import { describe, expect, it } from 'vitest';
import { FRAME, FRAME_MAX, KEY_STEP, MARGIN, TARGETS_MAX, WHEEL_MAX, ZOOM, dotSpacing, fitView, frameSize, isAnimating, keyAction, readPreviewHand, readPreviewState, readPreviewTargets, readPreviewWheel, zoomAt } from './designCanvasView.js';

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

  it('reads a scroll the page passed up, capped and held inside the frame', () => {
    const frame = { width: 1440, height: 900 };
    expect(readPreviewWheel({ nekkoPreview: 'wheel', dx: 3, dy: -40, x: 200, y: 300, zoom: true, extra: 1 }, frame))
      .toEqual({ nekkoPreview: 'wheel', dx: 3, dy: -40, x: 200, y: 300, zoom: true });
    expect(readPreviewWheel({ nekkoPreview: 'wheel', dx: 1e9, dy: -1e9, x: -50, y: 5000, zoom: 'yes' }, frame))
      .toEqual({ nekkoPreview: 'wheel', dx: WHEEL_MAX, dy: -WHEEL_MAX, x: 0, y: 900, zoom: false });
    for (const bad of [null, 'wheel', { nekkoPreview: 'wheel' }, { nekkoPreview: 'wheel', dx: '1', dy: 0, x: 0, y: 0 }, { nekkoPreview: 'wheel', dx: NaN, dy: 0, x: 0, y: 0 }, { nekkoPreview: 'state', dx: 0, dy: 0, x: 0, y: 0 }]) {
      expect(readPreviewWheel(bad, frame)).toBeNull();
    }
  });

  it('reads Space pressed or let go in the page, and nothing else', () => {
    expect(readPreviewHand({ nekkoPreview: 'hand', down: true })).toBe(true);
    expect(readPreviewHand({ nekkoPreview: 'hand', down: false })).toBe(false);
    for (const bad of [null, { nekkoPreview: 'hand' }, { nekkoPreview: 'hand', down: 1 }, { nekkoPreview: 'wheel', down: true }]) expect(readPreviewHand(bad)).toBeNull();
  });

  it('reads clickable boxes cut to the frame and drops anything malformed', () => {
    const frame = { width: 1440, height: 900 };
    expect(readPreviewTargets({ nekkoPreview: 'targets', boxes: [[10, 20, 80, 30], [1400, 880, 100, 100], [-50, 10, 60, 20], [2000, 10, 50, 50], [1, 2, 3], ['1', 2, 3, 4], [0, 0, NaN, 4], 'x'] }, frame))
      .toEqual([[10, 20, 80, 30], [1400, 880, 40, 20], [0, 10, 10, 20]]);
    expect(readPreviewTargets({ nekkoPreview: 'targets', boxes: Array.from({ length: TARGETS_MAX + 50 }, () => [0, 0, 10, 10]) }, frame)).toHaveLength(TARGETS_MAX);
    for (const bad of [null, {}, { nekkoPreview: 'targets' }, { nekkoPreview: 'targets', boxes: 'all' }, { nekkoPreview: 'state', boxes: [] }]) expect(readPreviewTargets(bad, frame)).toBeNull();
  });

  it('moves and zooms from the keyboard, leaving modified keys to the app', () => {
    const view = { z: 0.5, x: 100, y: 40 };
    const canvas = { width: 1000, height: 600 };
    const key = (k: string, over: Record<string, boolean> = {}) => keyAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over }, view, canvas);
    expect(key('ArrowRight')).toEqual({ ...view, x: 100 - KEY_STEP.near });
    expect(key('ArrowUp', { shiftKey: true })).toEqual({ ...view, y: 40 + KEY_STEP.far });
    expect((key('+') as { z: number }).z).toBeCloseTo(0.5 * ZOOM.step);
    expect((key('-') as { z: number }).z).toBeCloseTo(0.5 / ZOOM.step);
    expect((key('1') as { z: number }).z).toBe(1);
    expect(key('0')).toBe('fit');
    expect(key('0', { metaKey: true })).toBeNull();
    expect(key('=', { ctrlKey: true })).toBeNull();
    expect(key('a')).toBeNull();
  });

  it('keeps the dotted surface between 12 and 36 pixels at every zoom', () => {
    for (const z of [ZOOM.min, 0.25, 0.5, 1, 2, ZOOM.max]) expect(dotSpacing(z)).toBeGreaterThanOrEqual(12), expect(dotSpacing(z)).toBeLessThanOrEqual(36);
    expect(dotSpacing(1)).toBe(18);
  });
});
