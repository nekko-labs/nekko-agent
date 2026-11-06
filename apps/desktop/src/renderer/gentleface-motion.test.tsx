import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const hooks = vi.hoisted(() => ({ el: null as unknown, effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: () => ({ current: hooks.el }),
  useId: () => ':fixture:',
  useLayoutEffect: (effect: typeof hooks.effect) => { hooks.effect = effect; },
}));
import { GfIcon } from './gentleface-icons.js';
import { GENTLEFACE_MOTION } from './gentleface-motion-assets.js';

function fixture(name: 'send' | 'stop' = 'send') {
  const svg = { pauseAnimations: vi.fn(), unpauseAnimations: vi.fn(), setCurrentTime: vi.fn() };
  const control = Object.assign(new EventTarget(), { matches: vi.fn(() => false) });
  const media = Object.assign(new EventTarget(), { matches: false });
  hooks.el = { querySelector: () => svg, closest: () => control };
  vi.stubGlobal('window', { matchMedia: () => media });
  const element = GfIcon({ name });
  const cleanup = hooks.effect?.();
  return { svg, control, media, element, cleanup: () => { if (typeof cleanup === 'function') cleanup(); } };
}

beforeEach(() => { vi.useFakeTimers(); hooks.effect = undefined; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Gentleface SVG clock lifecycle (#1998)', () => {
  it('pauses the new SVG without seeking its already-zero clock', () => {
    const f = fixture();
    expect(f.svg.pauseAnimations).toHaveBeenCalledOnce();
    expect(f.svg.setCurrentTime).not.toHaveBeenCalled();
    expect(f.svg.unpauseAnimations).not.toHaveBeenCalled();
    f.cleanup();
    expect(f.svg.setCurrentTime).not.toHaveBeenCalled();
  });

  it('keys motion SVGs by icon identity, so name changes get a fresh clock', () => {
    const f = fixture();
    const children = f.element.props.children as ReactElement[];
    expect(children[1].key).toBe('send');
    f.cleanup();
  });

  it.each(['focus', 'click', 'pointerenter'])('keeps the %s one-shot and resets at its original deadline', event => {
    const f = fixture();
    f.control.dispatchEvent(new Event(event));
    expect(f.svg.unpauseAnimations).toHaveBeenCalledOnce();
    expect(f.svg.setCurrentTime).toHaveBeenLastCalledWith(GENTLEFACE_MOTION.send.frames[0]);
    vi.advanceTimersByTime((GENTLEFACE_MOTION.send.frames[1] - GENTLEFACE_MOTION.send.frames[0]) * 1000);
    expect(f.svg.setCurrentTime).toHaveBeenLastCalledWith(0);
    f.cleanup();
  });

  it('cancels a running timer and listeners without seeking the departing SVG', () => {
    const f = fixture();
    f.control.dispatchEvent(new Event('click'));
    f.svg.setCurrentTime.mockClear();
    f.svg.pauseAnimations.mockClear();
    f.cleanup();
    vi.runAllTimers();
    f.control.dispatchEvent(new Event('click'));
    f.media.dispatchEvent(new Event('change'));
    expect(f.svg.setCurrentTime).not.toHaveBeenCalled();
    expect(f.svg.pauseAnimations).not.toHaveBeenCalled();
    expect(f.svg.unpauseAnimations).toHaveBeenCalledOnce();
  });

  it('restarts repeated interactions, keeping just one reset timer', () => {
    const f = fixture();
    f.control.dispatchEvent(new Event('click'));
    vi.advanceTimersByTime(500);
    f.control.dispatchEvent(new Event('click'));
    expect(vi.getTimerCount()).toBe(1);
    expect(f.svg.unpauseAnimations).toHaveBeenCalledTimes(2);
    f.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still stops on reduced-motion changes and refuses further playback', () => {
    const f = fixture();
    f.control.dispatchEvent(new Event('click'));
    f.media.matches = true;
    f.media.dispatchEvent(new Event('change'));
    expect(f.svg.setCurrentTime).toHaveBeenLastCalledWith(0);
    f.control.dispatchEvent(new Event('focus'));
    expect(f.svg.unpauseAnimations).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.cleanup();
  });

  it('keeps disabled controls and touch hover still', () => {
    const f = fixture();
    f.control.matches.mockReturnValue(true);
    f.control.dispatchEvent(new Event('click'));
    f.control.matches.mockReturnValue(false);
    f.control.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'touch' }));
    expect(f.svg.setCurrentTime).not.toHaveBeenCalled();
    expect(f.svg.unpauseAnimations).not.toHaveBeenCalled();
    f.cleanup();
  });

  it('does no clock work for a static glyph', () => {
    const f = fixture('stop');
    expect(f.svg.pauseAnimations).not.toHaveBeenCalled();
    expect(f.svg.setCurrentTime).not.toHaveBeenCalled();
    f.cleanup();
  });
});
