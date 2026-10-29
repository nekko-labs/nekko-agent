import { describe, expect, it } from 'vitest';
import { arcKeyframes } from './agentCardMotion.js';

const at = (k: Keyframe) => (k.transform as string).match(/-?[\d.]+/g)!.map(Number);

describe('agent card motion', () => {
  it('starts at the old place, ends at the new one, and bows out to the right on the way', () => {
    const frames = arcKeyframes(0, 200, 40);
    expect(at(frames[0])).toEqual([0, 0]);
    expect(at(frames.at(-1)!)).toEqual([0, 200]);
    const mid = at(frames[8]);
    expect(mid).toEqual([20, 100]);
    // Rightward the whole way, never back past the straight line.
    expect(frames.every((f) => at(f)[0] >= 0)).toBe(true);
  });

  it('bows right whichever way the card travels', () => {
    expect(at(arcKeyframes(0, -200, 40)[8])).toEqual([20, -100]);
  });
});
