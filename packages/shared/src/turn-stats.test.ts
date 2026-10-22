import { describe, expect, it } from 'vitest';
import { turnTokensPerSecond } from './turn-stats.js';

describe('turn stats', () => {
  it('rates by decode time when known, else wall time', () => {
    expect(turnTokensPerSecond({ outputTokens: 200, outputMs: 2000, wallMs: 10_000 })).toBe(100);
    expect(turnTokensPerSecond({ outputTokens: 200, wallMs: 10_000 })).toBe(20);
    expect(turnTokensPerSecond({ outputTokens: 0, wallMs: 0 })).toBe(0);
  });
});
