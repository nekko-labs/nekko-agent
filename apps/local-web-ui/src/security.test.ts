import { describe, expect, it } from 'vitest';
import { hostAllowed, originAllowed, tokenMatches, validateBindSecurity } from './security.js';

describe('web server security policy', () => {
  it('keeps loopback binds unauthenticated', () => {
    expect(() => validateBindSecurity('127.0.0.1', '', false)).not.toThrow();
    expect(() => validateBindSecurity('0.0.0.0', '', false)).toThrow(/NEKKO_TOKEN/);
    expect(() => validateBindSecurity('0.0.0.0', '', true)).not.toThrow();
  });

  it('compares tokens without plain equality', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secret', 'secreT')).toBe(false);
    expect(tokenMatches('secret', 'secret-longer')).toBe(false);
  });

  it('allows expected hosts and configured reverse-proxy hosts only', () => {
    expect(hostAllowed('localhost:1440', '0.0.0.0', 1440, [])).toBe(true);
    expect(hostAllowed('192.168.1.5:1440', '0.0.0.0', 1440, [])).toBe(true);
    expect(hostAllowed('[2001:db8::5]:8443', '0.0.0.0', 1440, [])).toBe(true);
    expect(hostAllowed('proxy.example:443', '0.0.0.0', 1440, ['proxy.example:443'])).toBe(true);
    expect(hostAllowed('evil.example:1440', '0.0.0.0', 1440, [])).toBe(false);
  });

  it('allows no-origin clients and same-origin requests', () => {
    expect(originAllowed(undefined, 'http', 'localhost:1440', [])).toBe(true);
    expect(originAllowed('http://localhost:1440', 'http', 'localhost:1440', [])).toBe(true);
    expect(originAllowed('https://evil.example', 'http', 'localhost:1440', [])).toBe(false);
    expect(originAllowed('https://proxy.example', 'https', 'internal:1440', ['https://proxy.example'])).toBe(true);
  });
});
