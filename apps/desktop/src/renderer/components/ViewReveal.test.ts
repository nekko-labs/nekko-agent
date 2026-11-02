import { describe, expect, it } from 'vitest';
import { REVEAL, revealOrder, revealShade } from './ViewReveal.js';

describe('view reveal', () => {
  const cols = 80, rows = 50;
  const orders = Array.from({ length: cols * rows }, (_, i) => revealOrder(i % cols, Math.floor(i / cols), cols, rows));

  it('stays fast: covered for a beat, clear within about a third of a second', () => {
    expect(REVEAL.holdMs + REVEAL.dissolveMs).toBeLessThanOrEqual(320);
    expect(REVEAL.cell).toBeGreaterThanOrEqual(12);
  });

  it('starts fully covered and ends fully clear', () => {
    expect(orders.every((o) => revealShade(o, 0) === 0)).toBe(true);
    expect(orders.every((o) => revealShade(o, 1) === 4)).toBe(true);
  });

  it('steps each block down through the shades, never back up', () => {
    for (const o of orders.slice(0, 200)) {
      let last = 0;
      for (let p = 0; p <= 1; p += 0.02) {
        const shade = revealShade(o, p);
        expect(shade).toBeGreaterThanOrEqual(last);
        last = shade;
      }
    }
  });

  it('clears from the centre out, with jitter so no hard ring shows', () => {
    const at = (c: number, r: number) => orders[r * cols + c];
    const mean = (cells: number[][]) => cells.reduce((s, [c, r]) => s + at(c, r), 0) / cells.length;
    const centre = [[39, 24], [40, 25], [39, 25], [40, 24]], corners = [[0, 0], [79, 0], [0, 49], [79, 49]];
    expect(mean(centre)).toBeLessThan(mean(corners));
    expect(orders.every((o) => o >= 0 && o < 1)).toBe(true);
    // Mirror-image blocks sit at the same distance; the jitter sets them apart.
    const apart = orders.filter((o, i) => Math.abs(o - at(cols - 1 - (i % cols), Math.floor(i / cols))) > 0.02).length;
    expect(apart).toBeGreaterThan(orders.length * 0.8);
  });
});
