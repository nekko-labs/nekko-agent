import { describe, expect, it } from 'vitest';
import { COMPANION_DEFAULT, COMPANION_MAX, COMPANION_MIN, clampCompanion, readCompanionWidth, saveCompanionWidth, shareFromPointer } from './companionWidth.js';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('companion column width', () => {
  it('defaults, clamps and survives garbage', () => {
    expect(readCompanionWidth('s', memory())).toBe(COMPANION_DEFAULT);
    expect(clampCompanion(0.05)).toBe(COMPANION_MIN);
    expect(clampCompanion(2)).toBe(COMPANION_MAX);
    expect(clampCompanion(Number.NaN)).toBe(COMPANION_DEFAULT);
    const bad = { getItem: () => '{not json', setItem: () => {} };
    expect(readCompanionWidth('s', bad)).toBe(COMPANION_DEFAULT);
  });

  it('is kept per agent', () => {
    const store = memory();
    saveCompanionWidth('a', 0.5, store);
    expect(readCompanionWidth('a', store)).toBe(0.5);
    expect(readCompanionWidth('b', store)).toBe(COMPANION_DEFAULT);
  });

  it('measures from the right edge, where the column sits', () => {
    expect(shareFromPointer(700, 100, 1000)).toBe(0.4);
    expect(shareFromPointer(1090, 100, 1000)).toBe(COMPANION_MIN);
    expect(shareFromPointer(0, 100, 1000)).toBe(COMPANION_MAX);
  });
});
