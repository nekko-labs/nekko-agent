import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: { textScale: 100 } as { textScale?: number } | null, applyTheme: () => {} }));
const saveSettings = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./settingsIndex.js', () => ({ saveSettings }));
vi.mock('./store.js', () => ({
  useStore: { getState: () => state, setState: (patch: Partial<typeof state>) => Object.assign(state, patch) },
  textScaleOf: (v?: number) => v ?? 100,
}));

import { SHORTCUTS } from './shortcuts.js';
import { resetAppTextScale, stepAppTextScale, WHEEL_STEP, wheelStepper } from './textZoom.js';

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers }) as KeyboardEvent;

describe('text size keys', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    it(`steps up with ${modifier} and + or =, down with - or _`, () => {
      for (const value of ['+', '=']) expect(SHORTCUTS.textBigger.matches(key(value, { [modifier]: true }))).toBe(true);
      expect(SHORTCUTS.textBigger.matches(key('+', { [modifier]: true, shiftKey: true }))).toBe(true);
      for (const value of ['-', '_']) expect(SHORTCUTS.textSmaller.matches(key(value, { [modifier]: true }))).toBe(true);
    });
  }
  it('resets with Ctrl/⌘+0', () => {
    for (const modifier of ['ctrlKey', 'metaKey']) expect(SHORTCUTS.textReset.matches(key('0', { [modifier]: true }))).toBe(true);
  });
  it('ignores the keys without Ctrl/⌘, or with Alt', () => {
    for (const event of [key('+'), key('-'), key('0'), key('=', { ctrlKey: true, altKey: true }), key('-', { metaKey: true, altKey: true }), key('0', { ctrlKey: true, altKey: true })]) {
      expect(SHORTCUTS.textBigger.matches(event)).toBe(false);
      expect(SHORTCUTS.textSmaller.matches(event)).toBe(false);
      expect(SHORTCUTS.textReset.matches(event)).toBe(false);
    }
  });
});

describe('stepAppTextScale', () => {
  beforeEach(() => { vi.useFakeTimers(); state.settings = { textScale: 100 }; saveSettings.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('applies each step at once and saves only the last', () => {
    expect(stepAppTextScale(1)).toBe(110);
    expect(stepAppTextScale(1)).toBe(125);
    expect(state.settings?.textScale).toBe(125);
    expect(saveSettings).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ textScale: 125 });
  });

  it('resets to 100%, and does nothing already there', () => {
    state.settings = { textScale: 150 };
    expect(resetAppTextScale()).toBe(100);
    vi.runAllTimers();
    expect(saveSettings).toHaveBeenCalledWith({ textScale: 100 });
    saveSettings.mockClear();
    expect(resetAppTextScale()).toBeNull();
    vi.runAllTimers();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('stops at the limits', () => {
    state.settings = { textScale: 150 };
    expect(stepAppTextScale(1)).toBeNull();
    state.settings = { textScale: 80 };
    expect(stepAppTextScale(-1)).toBeNull();
    vi.runAllTimers();
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe('wheelStepper', () => {
  it('takes one step per notch, up for bigger', () => {
    const steps: number[] = [];
    let t = 0;
    const wheel = wheelStepper((d) => steps.push(d), () => t);
    wheel(-100); t += 50; wheel(100);
    expect(steps).toEqual([1, 1, -1, -1]);
  });

  it('adds up small trackpad deltas and forgets them after a pause', () => {
    const steps: number[] = [];
    let t = 0;
    const wheel = wheelStepper((d) => steps.push(d), () => t);
    wheel(-WHEEL_STEP / 2); t += 10; wheel(-WHEEL_STEP / 2);
    expect(steps).toEqual([1]);
    wheel(-WHEEL_STEP / 2); t += 1000; wheel(-WHEEL_STEP / 2);
    expect(steps).toEqual([1]);
  });
});
