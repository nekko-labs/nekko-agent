import { describe, expect, it } from 'vitest';
import { fillTone } from './contextTone.js';

describe('fillTone', () => {
  it.each([[0, 'success'], [59.99, 'success'], [60, 'warning'], [84.99, 'warning'], [85, 'danger'], [100, 'danger'], [120, 'danger'], [NaN, 'ink-faint']])('uses the capacity boundary for %s', (percent, tone) => {
    expect(fillTone(Number(percent))).toBe(`var(--${tone})`);
  });
});
