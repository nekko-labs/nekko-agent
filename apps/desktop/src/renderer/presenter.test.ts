import { describe, expect, it } from 'vitest';
import { createMasker } from './presenter.js';

describe('presenter mode', () => {
  const mask = createMasker({ user: 'travis', home: 'C:\Users\travis', host: 'TRAVIS-PC' });

  it('masks account emails, home paths, user and host names, and keys', () => {
    expect(mask('Claude Code · travis@nekkolabs.com')).toBe('Claude Code · you@example.com');
    expect(mask('C:\Users\travis\dev\app')).toBe('~\dev\app');
    expect(mask('/Users/someone/code and someone again')).toBe('~/code and demo again');
    expect(mask('Model Server on TRAVIS-PC')).toBe('Model Server on workstation');
    expect(mask('key sk-ant-api03-abcdef123')).toBe('key sk-••••');
    expect(mask('Write to maria.lopez@example.com')).toBe('Write to maria.lopez@example.com');
    expect(mask('Plain text stays... as it is')).toBe('Plain text stays... as it is');
  });

});
