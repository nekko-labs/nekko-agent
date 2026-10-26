import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTimestampSwipe, WHEEL_RELEASE_MS } from './timestampSwipe.js';

function fixture() {
  vi.useFakeTimers();
  const target = new EventTarget();
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const el = Object.assign(target, {
    style: { setProperty: (k: string, v: string) => properties.set(k, v) },
    classList: {
      add: (k: string) => classes.add(k), remove: (k: string) => classes.delete(k),
      toggle: (k: string, on: boolean) => (on ? classes.add(k) : classes.delete(k), on),
    },
    closest: () => null,
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { getSelection: () => null }));
  const cleanup = attachTimestampSwipe(el as unknown as HTMLElement);
  const send = (type: string, props = {}) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, isPrimary: true, button: 0, clientX: 200, clientY: 100, ...props,
  }));
  // The row offset lives in --vt-reveal, applied only while .vt-revealing is set.
  const shift = () => (classes.has('vt-revealing') ? properties.get('--vt-reveal') : '');
  return { send, properties, shift, cleanup, el };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('timestamp swipe', () => {
  it('holds a paused drag until pointer-up, then removes the transform after settling', () => {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 50 });
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
    f.send('pointerdown'); f.send('pointermove', { clientX: 190, clientY: 150 });
    f.send('pointermove', { clientX: 50 }); expect(f.shift()).toBe(''); f.cleanup();
  });
  it.each(['pointercancel', 'lostpointercapture'])('settles on %s', type => {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 50 });
    f.send(type); vi.advanceTimersByTime(250); expect(f.shift()).toBe(''); f.cleanup();
  });
  it('cleans pending timers and styles on unmount', () => {
    const f = fixture(); f.send('wheel', { deltaX: 112, deltaY: 0 }); f.cleanup();
    vi.advanceTimersByTime(2000); expect(f.shift()).toBe('');
    expect(f.properties.get('--vt-reveal-o')).toBe('0');
  });
});
