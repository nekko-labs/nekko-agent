import { describe, expect, it } from 'vitest';
import { computerColor, computerIdOf, COMPUTER_COLORS } from './computers.js';

describe('computerIdOf', () => {
  it('reads the computer from a qualified id', () => {
    expect(computerIdOf('@ab12cd34:s_1')).toBe('ab12cd34');
    expect(computerIdOf('@ab12cd34:folder:with:colons')).toBe('ab12cd34');
  });

  it('is null for anything local', () => {
    expect(computerIdOf('s_1')).toBeNull();
    expect(computerIdOf('')).toBeNull();
    expect(computerIdOf(null)).toBeNull();
    expect(computerIdOf(undefined)).toBeNull();
    expect(computerIdOf('@:s_1')).toBeNull();
    expect(computerIdOf('@nocolon')).toBeNull();
  });
});

describe('computerColor', () => {
  it('wraps around the palette', () => {
    expect(computerColor({ color: COMPUTER_COLORS.length })).toBe(COMPUTER_COLORS[0]);
  });
});
