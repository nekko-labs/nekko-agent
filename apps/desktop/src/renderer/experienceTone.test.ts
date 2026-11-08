import { describe, expect, it } from 'vitest';
import { TONES, readTone, withTone } from './experienceTone.js';

describe('experience tone', () => {
  it('leaves existing instructions byte-for-byte intact when reset', () => {
    const original = 'Use Japanese.\n\n  Keep this whitespace.\n';
    for (const tone of Object.keys(TONES) as (keyof typeof TONES)[]) {
      const next = withTone(original, tone);
      expect(readTone(next)).toBe(tone);
      expect(withTone(next, 'Default')).toBe(original);
    }
  });
  it('replaces only its own preference, never duplicates it', () => {
    const next = withTone(withTone('Do not publish credentials.', 'Friendly'), 'Concise');
    expect(next).toContain('Do not publish credentials.');
    expect(next.match(/<nekko-tone>/g)).toHaveLength(1);
    expect(readTone(next)).toBe('Concise');
    expect(withTone(next, 'Concise')).toBe(next);
  });
  it('does not infer a tone from arbitrary instructions', () => {
    expect(readTone('Friendly')).toBe('Default');
    expect(withTone('', 'Default')).toBe('');
  });
});
