import { describe, expect, it } from 'vitest';
import { RUNNER_DOT_BGRA, paintDot } from './trayDot.js';

describe('paintDot', () => {
  it('paints the dot bottom-right and nothing else', () => {
    const src = Buffer.alloc(20 * 20 * 4, 0x11);
    const out = paintDot(src, 20, 20, RUNNER_DOT_BGRA);
    const px = (x: number, y: number) => [...out.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
    expect(px(15, 15)).toEqual([...RUNNER_DOT_BGRA]);
    expect(px(19, 16)).toEqual([...RUNNER_DOT_BGRA]);
    expect(px(2, 2)).toEqual([0x11, 0x11, 0x11, 0x11]);
    expect(px(11, 15)).toEqual([0, 0, 0, 0]); // the transparent ring keeps the dot off the icon
    expect(src[(15 * 20 + 15) * 4]).toBe(0x11); // input untouched
  });
});
