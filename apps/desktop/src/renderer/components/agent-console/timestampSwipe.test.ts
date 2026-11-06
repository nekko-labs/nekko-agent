import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTimestampSwipe, WHEEL_RELEASE_MS } from './timestampSwipe.js';

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
  it('allows wheel pauses longer than the old 120ms and settles after wheel inactivity', () => {
    const f = fixture(); f.send('wheel', { deltaX: 112, deltaY: 0 });
    vi.advanceTimersByTime(300); expect(f.shift()).toBe('112px');
    f.send('wheel', { deltaX: 10, deltaY: 0 });
    vi.advanceTimersByTime(WHEEL_RELEASE_MS); expect(f.shift()).toBe('0px'); f.cleanup();
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
