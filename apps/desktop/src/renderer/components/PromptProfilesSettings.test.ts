import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { withProfile } from './PromptProfilesSettings.js';

const base = { promptProfiles: { auto: true, models: { 'p::m': 'small' } } } as unknown as AppSettings;

describe('withProfile', () => {
  it('sets an override and keeps the rest', () => {
    expect(withProfile(base, 'providers', 'p', 'medium')).toEqual({ auto: true, models: { 'p::m': 'small' }, providers: { p: 'medium' } });
  });
  it('removes an override when set back to automatic', () => {
    expect(withProfile(base, 'models', 'p::m', 'auto').models).toEqual({});
  });
});
