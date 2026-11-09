import { describe, expect, it } from 'vitest';
import { isAuroraHour, isChristmas, isShogatsu, mergeConfetti, seasonalHat, snowballTap, SNOWBALL_TAP_WINDOW_MS } from './seasonal.js';

const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour);

describe('seasonal hats', () => {
  it('gives Spooky the wizard hat and Winter the beanie', () => {
    expect(seasonalHat('autumn', at(11, 9))).toBe('wizard');
    expect(seasonalHat('winter', at(11, 9))).toBe('beanie');
  });
  it('turns the beanie into a Santa hat on December 24 and 25 only', () => {
    expect(seasonalHat('winter', at(12, 23))).toBe('beanie');
    expect(seasonalHat('winter', at(12, 24))).toBe('santa');
    expect(seasonalHat('winter', at(12, 25, 23))).toBe('santa');
    expect(seasonalHat('winter', at(12, 26))).toBe('beanie');
    // Spooky keeps its wizard hat at Christmas.
    expect(seasonalHat('autumn', at(12, 25))).toBe('wizard');
  });
  it('dresses nobody under any other theme', () => {
    for (const p of [undefined, 'dark', 'light', 'nord', 'x-plum-white']) expect(seasonalHat(p, at(12, 25))).toBeUndefined();
  });
});

describe('date and hour eggs', () => {
  it('knows Christmas, Oshogatsu and the aurora hours in local time', () => {
    expect(isChristmas(at(12, 24))).toBe(true);
    expect(isChristmas(at(1, 24))).toBe(false);
    for (const d of [1, 2, 3]) expect(isShogatsu(at(1, d))).toBe(true);
    expect(isShogatsu(at(1, 4))).toBe(false);
    expect(isShogatsu(at(12, 31))).toBe(false);
    for (const h of [22, 23, 0, 3]) expect(isAuroraHour(at(1, 10, h))).toBe(true);
    for (const h of [4, 12, 21]) expect(isAuroraHour(at(1, 10, h))).toBe(false);
  });
});

describe('merged-PR confetti', () => {
  it('scatters leaves for Spooky and snow for Winter', () => {
    expect(mergeConfetti('autumn', at(11, 9))).toContain('🎃');
    expect(mergeConfetti('winter', at(11, 9))).toEqual(['❄️', '⛄', '❄️', '⛄', '❄️', '⛄']);
  });
  it('turns festive at Christmas and kadomatsu at Oshogatsu', () => {
    expect(mergeConfetti('winter', at(12, 25))).toContain('🎄');
    expect(mergeConfetti('winter', at(1, 2))).toContain('🎍');
  });
  it('has none for other themes', () => {
    expect(mergeConfetti('ember', at(12, 25))).toBeUndefined();
    expect(mergeConfetti(undefined)).toBeUndefined();
  });
});

describe('snowball taps', () => {
  it('throws on the third tap in quick succession and starts over', () => {
    let state = snowballTap([], 0);
    expect(state.throws).toBe(false);
    state = snowballTap(state.taps, 400);
    expect(state.throws).toBe(false);
    state = snowballTap(state.taps, 800);
    expect(state).toEqual({ taps: [], throws: true });
  });
  it('forgets taps older than the window', () => {
    let state = snowballTap([], 0);
    state = snowballTap(state.taps, 500);
    state = snowballTap(state.taps, SNOWBALL_TAP_WINDOW_MS + 400);
    expect(state.throws).toBe(false);
    expect(state.taps).toHaveLength(2);
  });
});
