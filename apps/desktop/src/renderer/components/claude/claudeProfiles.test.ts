import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import { claudeAccountName } from '@nekko-agent/shared';
import { claudeProfileConflict } from './claudeProfiles.js';

const p = (id: string, kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id, kind, label: id, baseUrl: '', enabled: true, ...extra });
const personal = p('Personal', 'claude-code');
const work = p('Work', 'claude-code', { claudeCode: { account: 'work' } });
const production = p('Production', 'anthropic', { apiKey: 'do-not-render' });
const providers = [personal, work, production, p('Local', 'ollama')];

describe('subscription profile collision guard', () => {
  it('blocks normalized and disabled saved profiles before sign-in', () => {
    expect(claudeProfileConflict(providers, claudeAccountName('Work!!'))).toBe(work);
    expect(claudeProfileConflict([{ ...work, enabled: false }], 'work')).toEqual({ ...work, enabled: false });
    expect(claudeProfileConflict([p('Old', 'claude-code', { claudeCode: { account: 'WORK' } })], 'work')?.id).toBe('Old');
  });
  it('permits a new profile without requiring a default connection', () => {
    expect(claudeProfileConflict([work], claudeAccountName('Client A'))).toBeUndefined();
    expect(claudeProfileConflict(providers, '')).toBeUndefined();
  });
  it('ignores API connections, which have no profile folder', () => {
    expect(claudeProfileConflict([production], 'production')).toBeUndefined();
  });
});
