import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import { generateApiKey, withBind } from './lanKey.js';

describe('generateApiKey', () => {
  it('is 32 lowercase hex characters from 16 random bytes', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it('pads every byte to two digits', () => {
    const key = generateApiKey((buf) => buf.fill(0x0a));
    expect(key).toBe('0a'.repeat(16));
  });
});

describe('withBind', () => {
  const base = { ...DEFAULT_ENGINE_SETTINGS, apiKey: '' };

  it('fills a key when the LAN is picked with none set', () => {
    const next = withBind(base, 'lan', () => 'generated');
    expect(next.bind).toBe('lan');
    expect(next.apiKey).toBe('generated');
    expect(withBind({ ...base, apiKey: '   ' }, 'lan', () => 'generated').apiKey).toBe('generated');
  });

  it('keeps a key the user already typed', () => {
    expect(withBind({ ...base, apiKey: 'mine' }, 'lan', () => 'generated').apiKey).toBe('mine');
  });

  it('never touches the key on the way back to loopback', () => {
    expect(withBind({ ...base, bind: 'lan', apiKey: 'mine' }, 'local').apiKey).toBe('mine');
    expect(withBind(base, 'local').apiKey).toBe('');
  });

  it('produces a real key by default', () => {
    expect(withBind(base, 'lan').apiKey).toMatch(/^[0-9a-f]{32}$/);
  });
});
