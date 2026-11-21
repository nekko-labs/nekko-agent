import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { withModelInstructions, withProfile } from './PromptProfilesSettings.js';

const base = { promptProfiles: { auto: true, models: { 'p::m': 'small' } } } as unknown as AppSettings;

describe('withProfile', () => {
  it('sets an override and keeps the rest', () => {
    expect(withProfile(base, 'providers', 'p', 'medium')).toEqual({ auto: true, models: { 'p::m': 'small' }, providers: { p: 'medium' } });
  });
  it('removes an override when set back to automatic', () => {
    expect(withProfile(base, 'models', 'p::m', 'auto').models).toEqual({});
  });
});

const route = 'p::m';
const otherRoute = 'other::m';
const scoped: AppSettings = { ...base, promptProfiles: { ...base.promptProfiles, modelInstructions: { [otherRoute]: 'Keep this.' } } };

describe('withModelInstructions', () => {
  it('saves trimmed, multiline guidance without changing size choices or another provider', () => {
    expect(withModelInstructions(scoped, route, '  First line.\nSecond line.  ')).toEqual({
      ...base.promptProfiles, modelInstructions: { [route]: 'First line.\nSecond line.', [otherRoute]: 'Keep this.' },
    });
    expect(scoped.promptProfiles?.modelInstructions).toEqual({ [otherRoute]: 'Keep this.' });
  });
  it('removes a blank overlay without removing the exact model size choice', () => {
    const saved = { ...scoped, promptProfiles: withModelInstructions(scoped, route, 'Remove me.') };
    expect(withModelInstructions(saved, route, ' \n ')).toEqual(scoped.promptProfiles);
    expect(withProfile(saved, 'models', route, 'auto').modelInstructions).toEqual(saved.promptProfiles.modelInstructions);
  });
});
