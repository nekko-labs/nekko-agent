import { describe, expect, it } from 'vitest';
import { patchPrivacy, privacyMode, toggleAllowed } from './privacy.js';

describe('privacy shield options', () => {
  it('lets the chat override the app default', () => {
    expect(privacyMode({}, {})).toBe('off');
    expect(privacyMode({}, { privacyMode: 'redact' })).toBe('redact');
    expect(privacyMode({ privacy: { mode: 'off' } }, { privacyMode: 'redact' })).toBe('off');
    expect(privacyMode({ privacy: { mode: 'redact' } }, null)).toBe('redact');
  });

  it('patches without dropping the other fields', () => {
    expect(patchPrivacy({ mode: 'redact', allow: ['a'] }, { disabledKinds: ['ip'] })).toEqual({ mode: 'redact', allow: ['a'], disabledKinds: ['ip'] });
  });

  it('adds and removes allowed values once', () => {
    expect(toggleAllowed(undefined, 'a@b.io', true)).toEqual(['a@b.io']);
    expect(toggleAllowed(['a@b.io'], 'a@b.io', true)).toEqual(['a@b.io']);
    expect(toggleAllowed(['a@b.io', 'x'], 'a@b.io', false)).toEqual(['x']);
  });
});
