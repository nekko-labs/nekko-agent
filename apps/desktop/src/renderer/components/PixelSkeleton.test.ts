import { describe, expect, it } from 'vitest';
import { pixelSkeletonNoise, pixelSkeletonShade, PIXEL_SKELETON } from './PixelSkeleton.js';

describe('PixelSkeleton helpers', () => {
  it('noise stays in [0, 1) and is deterministic per cell', () => {
    for (let col = 0; col < 8; col++) {
      for (let row = 0; row < 8; row++) {
        const a = pixelSkeletonNoise(col, row);
        const b = pixelSkeletonNoise(col, row);
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
    }
  });

  it('noise is varied across the grid, not a constant', () => {
    const values = new Set<number>();
    for (let col = 0; col < 16; col++) for (let row = 0; row < 16; row++) values.add(pixelSkeletonNoise(col, row));
    expect(values.size).toBeGreaterThan(200);
  });

  it('weights the shades toward the fuller blocks so the pattern reads as a card', () => {
    const counts = [0, 0, 0, 0];
    for (let col = 0; col < 32; col++) for (let row = 0; row < 32; row++) counts[pixelSkeletonShade(pixelSkeletonNoise(col, row))]++;
    const total = counts.reduce((a, b) => a + b, 0);
    expect(counts[0] / total).toBeGreaterThan(0.3);
    expect(counts[3] / total).toBeLessThan(0.2);
  });

  it('reveal ends inside its budget', () => {
    expect(PIXEL_SKELETON.revealMs).toBeLessThanOrEqual(400);
  });
});
