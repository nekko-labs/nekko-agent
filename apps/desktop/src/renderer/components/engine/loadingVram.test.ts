import { describe, expect, it } from 'vitest';
import { vramFill } from './loadingVram.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('vramFill', () => {
  it('lays out what others hold, what the load took and what it still needs', () => {
    // A 12 GB card with 2 GB in use; the load needs 6 GB and has 3 GB in.
    const v = vramFill({ totalBytes: 12 * GB, beforeBytes: 10 * GB, freeBytes: 7 * GB, needBytes: 6 * GB }, 500 * MB);
    expect(v.othersPct).toBeCloseTo((2 / 12) * 100);
    expect(v.landedPct).toBeCloseTo((3 / 12) * 100);
    expect(v.remainingPct).toBeCloseTo((3 / 12) * 100);
    expect(v.reservePct).toBeCloseTo(((12 * GB - 500 * MB) / (12 * GB)) * 100);
    expect(v.over).toBe('none');
  });

  it('says when a load reaches into the reserve, and when it needs more than the card has', () => {
    const into = vramFill({ totalBytes: 8 * GB, beforeBytes: 6 * GB, freeBytes: 6 * GB, needBytes: 5.8 * GB }, 500 * MB);
    expect(into.over).toBe('reserve');
    const past = vramFill({ totalBytes: 8 * GB, beforeBytes: 6 * GB, freeBytes: 5 * GB, needBytes: 9 * GB }, 500 * MB);
    expect(past.over).toBe('full');
    // Clipped at the card, never past it.
    expect(past.othersPct + past.landedPct + past.remainingPct).toBeCloseTo(100);
  });

  it('draws no reserve with overload protection off, and only overflow counts', () => {
    const v = vramFill({ totalBytes: 8 * GB, beforeBytes: 6 * GB, freeBytes: 6 * GB, needBytes: 5.8 * GB }, null);
    expect(v.reservePct).toBeNull();
    expect(v.over).toBe('none');
  });

  it('never reports a negative share when free memory rises mid-load', () => {
    const v = vramFill({ totalBytes: 8 * GB, beforeBytes: 4 * GB, freeBytes: 5 * GB, needBytes: 2 * GB }, 500 * MB);
    expect(v.landedPct).toBe(0);
    expect(v.landedBytes).toBe(0);
  });
});
