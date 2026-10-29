import { describe, expect, it } from 'vitest';
import { NO_BACKGROUND, backgroundLine } from './background.js';

describe('background line', () => {
  it('says nothing when nothing runs in the background', () => {
    expect(backgroundLine(NO_BACKGROUND)).toBeNull();
    expect(backgroundLine(null)).toBeNull();
  });

  it('says how many are paused, and why', () => {
    expect(backgroundLine({ running: 2, paused: 0, reason: null })).toBe('Background: 2 running');
    expect(backgroundLine({ running: 1, paused: 1, reason: 'active' })).toBe('Background: 1 paused · you’re using the computer');
    expect(backgroundLine({ running: 2, paused: 2, reason: 'chat' })).toBe('Background: 2 paused · your chat is using the model');
    expect(backgroundLine({ running: 1, paused: 1, reason: 'lowBattery' })).toBe('Background: 1 paused · battery low');
  });
});
