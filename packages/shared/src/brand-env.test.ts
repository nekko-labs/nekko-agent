import { describe, expect, it } from 'vitest';
import { brandEnv } from './brand-env.js';

describe('brandEnv', () => {
  it('reads the current name', () => {
    expect(brandEnv('TOKEN', { NEKKO_TOKEN: 'new' })).toBe('new');
  });

  // An empty value is how a caller turns a default off, so it has to count
  // as set rather than fall through to a default.
  it('treats an empty value as set', () => {
    expect(brandEnv('URL', { NEKKO_URL: '' })).toBe('');
  });

  it('is undefined when not set', () => {
    expect(brandEnv('TOKEN', {})).toBeUndefined();
    expect(brandEnv('TOKEN', { UNRELATED_TOKEN: 'x' })).toBeUndefined();
  });
});
