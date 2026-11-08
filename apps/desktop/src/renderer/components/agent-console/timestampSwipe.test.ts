import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTimestampSwipe, TIMESTAMP_REVEAL_PX, WHEEL_RELEASE_MS } from './timestampSwipe.js';

/** A line of text 100-300 wide at y 90-110, as the caret lookup would find it. */
function textAt(x: number, y: number) {
  return {
    startContainer: { nodeType: 3 },
    selectNodeContents: () => {},
    getClientRects: () => [{ left: 100, right: 300, top: 90, bottom: 110 }],
    x, y,
  };
}

function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('document', { caretRangeFromPoint: textAt });
  const target = new EventTarget();
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const list = { style: { transform: '' } };
  const el = Object.assign(target, {
    style: { setProperty: (k: string, v: string) => properties.set(k, v) },
    classList: {
      add: (k: string) => classes.add(k), remove: (k: string) => classes.delete(k),
      toggle: (k: string, on: boolean) => (on ? classes.add(k) : classes.delete(k), on),
    },
    closest: () => null,
    querySelector: () => list,
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { getSelection: () => null }));
  const cleanup = attachTimestampSwipe(el as unknown as HTMLElement);
  // Starts in the blank space past the end of the fixture's line of text.
  const send = (type: string, props = {}) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse', clientX: 400, clientY: 100, ...props,
  }));
  // The row offset is the list's own transform, set only while .vt-revealing is.
  const shift = () => (classes.has('vt-revealing') ? list.style.transform.replace(/^translateX\(-?(.*)\)$/, '$1') : '');
  return { send, properties, classes, shift, cleanup, el };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('timestamp swipe', () => {
  it('holds a paused drag until pointer-up, then removes the transform after settling', () => {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 250 });
    vi.advanceTimersByTime(2000);
    expect(f.shift()).toBe('112px');
    f.send('pointerup'); expect(f.shift()).toBe('0px');
    vi.advanceTimersByTime(250); expect(f.shift()).toBe(''); f.cleanup();
  });
  it('only reveals for leftward wheel input and lets rightward input close it', () => {
    const f = fixture();
    expect(f.send('wheel', { deltaX: -112, deltaY: 0 })).toBe(true);
    expect(f.shift()).toBe('');
    expect(f.classes.has('vt-stamps-on')).toBe(false);
    expect(f.send('wheel', { deltaX: 80, deltaY: 0 })).toBe(false);
    expect(f.shift()).toBe('80px');
    f.send('wheel', { deltaX: -20, deltaY: 0 }); expect(f.shift()).toBe('60px');
    f.send('wheel', { deltaX: -100, deltaY: 0 }); expect(f.shift()).toBe('');
    expect(f.classes.has('vt-stamps-on')).toBe(false); f.cleanup();
  });
  it('caps wheel travel and reverses without consuming overshoot', () => {
    const f = fixture(); f.send('wheel', { deltaX: 500, deltaY: 0 });
    expect(f.shift()).toBe(`${TIMESTAMP_REVEAL_PX}px`);
    f.send('wheel', { deltaX: 500, deltaY: 0 });
    f.send('wheel', { deltaX: -20, deltaY: 0 }); expect(f.shift()).toBe('92px'); f.cleanup();
  });
  it('starts returning promptly after wheel input stops, resetting only for new input', () => {
    const f = fixture(); f.send('wheel', { deltaX: 80, deltaY: 0 });
    vi.advanceTimersByTime(WHEEL_RELEASE_MS - 1); expect(f.shift()).toBe('80px');
    f.send('wheel', { deltaX: 32, deltaY: 0 });
    vi.advanceTimersByTime(WHEEL_RELEASE_MS - 1); expect(f.shift()).toBe('112px');
    vi.advanceTimersByTime(1); expect(f.shift()).toBe('0px');
    expect(f.classes.has('vt-swiping')).toBe(false);
    expect(f.classes.has('vt-stamps-on')).toBe(false);
    expect(WHEEL_RELEASE_MS).toBeLessThanOrEqual(80);
    vi.advanceTimersByTime(250); expect(f.shift()).toBe(''); f.cleanup();
  });
  it('caps a pointer pull and follows reversal immediately without overshoot', () => {
    const f = fixture(); f.send('pointerdown');
    f.send('pointermove', { clientX: 100 }); expect(f.shift()).toBe('112px');
    f.send('pointermove', { clientX: 50 }); expect(f.shift()).toBe('112px');
    f.send('pointermove', { clientX: 70 }); expect(f.shift()).toBe('92px');
    f.send('pointermove', { clientX: 200 }); expect(f.shift()).toBe('');
    f.send('pointerup'); expect(f.classes.has('vt-swiping')).toBe(false); f.cleanup();
  });
  it('does not reveal on a rightward pointer drag', () => {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 550 });
    expect(f.shift()).toBe(''); expect(f.el.setPointerCapture).not.toHaveBeenCalled(); f.cleanup();
  });
  it('ignores vertical movement and ctrl-wheel zoom', () => {
    const f = fixture(); f.send('wheel', { deltaX: 1, deltaY: 20 });
    f.send('wheel', { deltaX: 112, deltaY: 0, ctrlKey: true });
    f.send('pointerdown'); f.send('pointermove', { clientX: 390, clientY: 150 });
    f.send('pointermove', { clientX: 250 }); expect(f.shift()).toBe(''); f.cleanup();
  });
  it.each(['pointercancel', 'lostpointercapture'])('settles on %s', type => {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 250 });
    f.send(type); vi.advanceTimersByTime(250); expect(f.shift()).toBe(''); f.cleanup();
  });
  it('leaves a mouse drag that starts on text to select it', () => {
    const f = fixture(); f.send('pointerdown', { clientX: 200 }); f.send('pointermove', { clientX: 50 });
    expect(f.shift()).toBe(''); expect(f.el.setPointerCapture).not.toHaveBeenCalled(); f.cleanup();
  });
  it('treats a press just past the end of a line as starting on the text', () => {
    const f = fixture(); f.send('pointerdown', { clientX: 310 }); f.send('pointermove', { clientX: 150 });
    expect(f.shift()).toBe(''); f.cleanup();
  });
  it('still swipes from text on touch, which cannot select by dragging', () => {
    const f = fixture(); f.send('pointerdown', { clientX: 200, pointerType: 'touch' });
    f.send('pointermove', { clientX: 50, pointerType: 'touch' }); expect(f.shift()).toBe('112px'); f.cleanup();
  });
  it('cleans pending timers and styles on unmount', () => {
    const f = fixture(); f.send('wheel', { deltaX: 112, deltaY: 0 }); f.cleanup();
    vi.advanceTimersByTime(2000); expect(f.shift()).toBe('');
    expect(f.classes.has('vt-stamps-on')).toBe(false);
    expect(f.properties.size).toBe(0);
  });
});
