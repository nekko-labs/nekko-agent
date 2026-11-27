import { describe, expect, it } from 'vitest';
import { hexToHsl, hslToHex, lightnessAt, resolveHsl } from './ColorWheel.js';

type Hsl = [number, number, number];

/**
 * What the wheel does on each step of a lightness drag: it emits the hex for its
 * held colour at the new lightness, holds that colour, and the parent hands the
 * hex straight back as `value`.
 */
function dragLightness(start: string, steps: number[]): { held: Hsl; value: string; seen: Hsl[] } {
  let held: Hsl = hexToHsl(start);
  let value = start;
  const seen: Hsl[] = [];
  for (const l of steps) {
    const [h, s] = resolveHsl(held, value);
    held = [h, s, l];
    value = hslToHex(...held);
    seen.push(resolveHsl(held, value));
  }
  return { held, value, seen };
}

describe('ColorWheel, the vertical brightness bar', () => {
  it('keeps hue and saturation when dragged to black and back', () => {
    const [h0, s0] = hexToHsl('#2fae86');
    const { value, seen } = dragLightness('#2fae86', [40, 20, 5, 0, 10, 30, 44]);
    // At the very bottom the hex is black, but the wheel still knows the colour.
    expect(seen[3]).toEqual([h0, s0, 0]);
    expect(hslToHex(...seen[3])).toBe('#000000');
    for (const [h, s] of seen) { expect(h).toBeCloseTo(h0, 6); expect(s).toBeCloseTo(s0, 6); }
    // Back up, it is the same green again, not a grey.
    const [h, s] = hexToHsl(value);
    expect(Math.abs(h - h0)).toBeLessThan(2);
    expect(Math.abs(s - s0)).toBeLessThan(2);
  });

  it('keeps hue and saturation when dragged to white and back', () => {
    const [h0, s0] = hexToHsl('#fe3354');
    const { seen, value } = dragLightness('#fe3354', [70, 90, 100, 85, 60]);
    expect(hslToHex(...seen[2])).toBe('#ffffff');
    for (const [h, s] of seen) { expect(h).toBeCloseTo(h0, 6); expect(s).toBeCloseTo(s0, 6); }
    expect(Math.abs(hexToHsl(value)[0] - h0)).toBeLessThan(2);
  });

  it('does not drift the hue over many small steps near the dark end', () => {
    const [h0] = hexToHsl('#4a90e2');
    const steps = Array.from({ length: 200 }, (_, i) => (i % 2 ? 2 : 3));
    const { seen } = dragLightness('#4a90e2', steps);
    for (const [h] of seen) expect(h).toBeCloseTo(h0, 6);
  });

  it('takes a colour from outside (a preset, a typed hex) over what it held', () => {
    const held: Hsl = [160, 57, 0];
    expect(resolveHsl(held, '#000000')).toBe(held);
    expect(resolveHsl(held, '#336699')).toEqual(hexToHsl('#336699'));
    expect(resolveHsl([0, 0, 0], '#000000')).toEqual([0, 0, 0]);
  });

  it('matches the hex it sent whatever its case or spacing', () => {
    const held: Hsl = hexToHsl('#ab12cd');
    expect(resolveHsl(held, ' #AB12CD ')).toBe(held);
  });

  it('maps a press on the track to lightness, light at the top, clamped past either end', () => {
    expect(lightnessAt(100, 100, 120)).toBe(100);
    expect(lightnessAt(220, 100, 120)).toBe(0);
    expect(lightnessAt(160, 100, 120)).toBe(50);
    expect(lightnessAt(40, 100, 120)).toBe(100);
    expect(lightnessAt(400, 100, 120)).toBe(0);
    // A track not laid out yet sets nothing extreme.
    expect(lightnessAt(10, 0, 0)).toBe(50);
  });
});
