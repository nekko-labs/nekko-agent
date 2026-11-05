import { describe, expect, it } from 'vitest';
import { composerToolbarPlacement } from './composerToolbarPlacement.js';

const anchor = { left: 400, right: 480, top: 300, bottom: 320 };
describe('selection-connected formatting toolbar placement', () => {
  it('centers above the selected text using the actual toolbar dimensions', () => {
    expect(composerToolbarPlacement(anchor, 340, 38, 1000, 720)).toEqual({ x: 270, y: 252, side: 'above', pointer: 170 });
  });
  it('flips below a selection at the top of the viewport', () => {
    expect(composerToolbarPlacement({ ...anchor, top: 20, bottom: 40 }, 340, 38, 1000, 720)).toMatchObject({ y: 50, side: 'below' });
  });
  it('clamps at each viewport edge without wrapping or losing the pointer', () => {
    const left = composerToolbarPlacement({ left: 5, right: 25, top: 200, bottom: 220 }, 340, 38, 390, 720);
    expect(left).toMatchObject({ x: 8, pointer: 14 });
    const right = composerToolbarPlacement({ left: 370, right: 385, top: 200, bottom: 220 }, 340, 38, 390, 720);
    expect(right).toMatchObject({ x: 42, pointer: 326 });
  });
  it('keeps the measured toolbar inside even a short viewport', () => {
    expect(composerToolbarPlacement({ ...anchor, top: 20, bottom: 60 }, 340, 38, 390, 90).y).toBe(44);
  });
});
