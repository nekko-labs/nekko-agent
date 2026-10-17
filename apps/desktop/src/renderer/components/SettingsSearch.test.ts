import { describe, expect, it } from 'vitest';
import { findOffsets } from './SettingsSearch.js';

describe('settings search findOffsets', () => {
  it('finds every case-insensitive occurrence', () => {
    expect(findOffsets('Theme and theme', 'THEME')).toEqual([[0, 5], [10, 15]]);
  });
  it('matches inside words so partial keywords work', () => {
    expect(findOffsets('Guardrails', 'rail')).toEqual([[5, 9]]);
  });
  it('returns nothing for a blank query', () => {
    expect(findOffsets('Appearance', '   ')).toEqual([]);
  });
  it('ignores surrounding whitespace in the query', () => {
    expect(findOffsets('Show tips', ' tips ')).toEqual([[5, 9]]);
  });
});
