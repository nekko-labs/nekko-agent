import { describe, expect, it } from 'vitest';
import { pickerPlacement } from './pickerPlacement.js';

describe('composer picker placement', () => {
  it('opens above a bottom composer and clamps its right edge', () => {
    expect(pickerPlacement({ left: 900, top: 650, bottom: 680 }, 1000, 720))
      .toEqual({ left: 568, width: 416, maxHeight: 500, bottom: 78 });
  });
  it('opens below a trigger near the top', () => {
    expect(pickerPlacement({ left: 80, top: 30, bottom: 60 }, 1000, 720))
      .toEqual({ left: 80, width: 416, maxHeight: 500, top: 68 });
  });
  it('gives two columns room while still fitting a narrow window', () => {
    expect(pickerPlacement({ left: 900, top: 650, bottom: 680 }, 1000, 720, 640))
      .toEqual({ left: 344, width: 640, maxHeight: 500, bottom: 78 });
    expect(pickerPlacement({ left: 60, top: 170, bottom: 200 }, 320, 240, 640).width).toBe(288);
  });
  it('fits a narrow composer window without horizontal clipping', () => {
    const placement = pickerPlacement({ left: 60, top: 170, bottom: 200 }, 320, 240);
    expect(placement).toEqual({ left: 16, width: 288, maxHeight: 146, bottom: 78 });
  });
});
