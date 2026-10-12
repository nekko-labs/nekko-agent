import { describe, expect, it } from 'vitest';
import { DECOR_HZ, startDecorClock, type DecorAnimation } from './decorClock.js';

function fakeAnimation(animationName: string, startTime = 100) {
  const target = { isConnected: true };
  const a = {
    animationName,
    playState: 'running',
    startTime,
    currentTime: 0 as number | null,
    effect: { target: target as unknown as Element },
    pauses: 0,
    plays: 0,
    pause() { this.pauses++; this.playState = 'paused'; },
    play() { this.plays++; this.playState = 'running'; },
  };
  return Object.assign(a, { target });
}

function setup(animations: ReturnType<typeof fakeAnimation>[]) {
  type Listener = (e: { animationName: string; target: EventTarget | null }) => void;
  const listeners: Listener[] = [];
  const cancels: Listener[] = [];
  const attrs = new Set<string>();
  let interval: (() => void) | null = null;
  let intervalMs = 0;
  const doc = {
    hidden: false,
    documentElement: { hasAttribute: (n: string) => attrs.has(n) },
    timeline: { currentTime: 1000 },
    getAnimations: () => animations as unknown as DecorAnimation[],
    addEventListener: (t: 'animationstart' | 'animationcancel', fn: Listener) => { (t === 'animationstart' ? listeners : cancels).push(fn); },
    removeEventListener: () => { listeners.length = 0; cancels.length = 0; },
  };
  const timers = {
    setInterval: (fn: () => void, ms: number) => { interval = fn; intervalMs = ms; return 1; },
    clearInterval: () => { interval = null; },
  };
  const stop = startDecorClock(doc, timers);
  return { doc, attrs, listeners, cancels, stop, tick: () => interval?.(), running: () => interval !== null, intervalMs: () => intervalMs };
}

describe('decorClock', () => {
  it('does not invalidate beam styles twice inside the same discrete step', () => {
    const beam = fakeAnimation('composer-beam-spin', 0);
    Object.assign(beam.effect, {
      getTiming: () => ({ duration: 3200, easing: 'linear', iterations: Infinity, direction: 'normal' }),
      getKeyframes: () => [{ computedOffset: 0, easing: 'steps(48)' }, { computedOffset: 1, easing: 'steps(48)' }],
    });
    let writes = 0, time = 0;
    Object.defineProperty(beam, 'currentTime', { get: () => time, set: value => { time = value; writes++; } });
    const clock = setup([beam]);
    clock.doc.timeline.currentTime = 1000; clock.tick();
    clock.doc.timeline.currentTime = 1033; clock.tick();
    expect(writes).toBe(1);
    clock.doc.timeline.currentTime = 1067; clock.tick();
    expect(writes).toBe(2);
    expect(time).toBe(1067);
  });

  it('pauses the decorations and steps them itself, DECOR_HZ times a second', () => {
    const beam = fakeAnimation('composer-beam-spin', 400);
    const other = fakeAnimation('pr-deck-pop');
    const clock = setup([beam, other]);
    expect(beam.pauses).toBe(1);
    expect(other.pauses).toBe(0);
    expect(clock.intervalMs()).toBeCloseTo(1000 / DECOR_HZ);
    clock.doc.timeline.currentTime = 1500;
    clock.tick();
    // The same point in the animation the browser's clock would be at.
    expect(beam.currentTime).toBe(1100);
  });

  it('holds still while the window is inactive or hidden', () => {
    const beam = fakeAnimation('rocket-flame', 0);
    const clock = setup([beam]);
    clock.attrs.add('data-app-inactive');
    clock.doc.timeline.currentTime = 2000;
    clock.tick();
    expect(beam.currentTime).toBe(0);
    clock.attrs.delete('data-app-inactive');
    clock.tick();
    expect(beam.currentTime).toBe(2000);
  });

  it('picks up decorations that start later and lets go of finished ones', () => {
    const clock = setup([]);
    expect(clock.running()).toBe(false);
    const rocket = fakeAnimation('rocket-hover', 900);
    const host = { getAnimations: () => [rocket] } as unknown as EventTarget;
    clock.listeners.forEach((fn) => fn({ animationName: 'rocket-hover', target: host }));
    expect(rocket.pauses).toBe(1);
    expect(clock.running()).toBe(true);
    rocket.target.isConnected = false;
    clock.tick();
    expect(clock.running()).toBe(false);
  });

  it('lets go of a decoration the stylesheet cancels, so it is never brought back', () => {
    const rocket = fakeAnimation('rocket-streak', 0);
    const clock = setup([rocket]);
    clock.cancels.forEach((fn) => fn({ animationName: 'rocket-streak', target: rocket.target as unknown as EventTarget }));
    clock.doc.timeline.currentTime = 5000;
    clock.tick();
    expect(rocket.currentTime).toBe(0);
    expect(clock.running()).toBe(false);
  });

  it('never reads what would bring styles up to date on a tick', () => {
    const beam = fakeAnimation('composer-beam-spin', 0);
    const clock = setup([beam]);
    // Reading a CSS animation's playState or effect makes Chromium recalc style;
    // once held, the tick may only write currentTime.
    let reads = 0;
    Object.defineProperty(beam, 'playState', { get: () => { reads++; return 'paused'; } });
    Object.defineProperty(beam, 'effect', { get: () => { reads++; return null; } });
    clock.doc.timeline.currentTime = 1234;
    clock.tick();
    clock.tick();
    expect(reads).toBe(0);
    expect(beam.currentTime).toBe(1234);
  });

  it('hands every decoration back to the browser when stopped', () => {
    const beam = fakeAnimation('pixel-blink');
    const clock = setup([beam]);
    clock.stop();
    expect(beam.plays).toBe(1);
    expect(clock.running()).toBe(false);
  });
});
