import { describe, expect, it } from 'vitest';
import {
  apiServerBindHost,
  apiServerMcpConfig,
  apiServerRefusal,
  apiServerUrl,
  mcpServerEntry,
  withApiServerDefaults,
} from './api-server.js';
import { trimTrailingSlashes } from './trim.js';

const base = withApiServerDefaults({ token: 't0k' });

describe('api server addresses', () => {
  it('is on by default, on loopback, with the default port', () => {
    expect(withApiServerDefaults(undefined)).toMatchObject({ enabled: true, bind: 'local', port: 1439 });
    expect(apiServerBindHost(base)).toBe('127.0.0.1');
    expect(apiServerUrl(base)).toBe('http://127.0.0.1:1439');
  });

  it('binds every interface for lan, but quotes an address someone can dial', () => {
    const lan = { ...base, bind: 'lan' as const };
    expect(apiServerBindHost(lan)).toBe('0.0.0.0');
    expect(apiServerUrl(lan, '192.168.1.5')).toBe('http://192.168.1.5:1439');
  });

  it('binds a custom host, bracketing IPv6', () => {
    expect(apiServerUrl({ ...base, bind: 'custom', host: '10.0.0.2' })).toBe('http://10.0.0.2:1439');
    expect(apiServerUrl({ ...base, bind: 'custom', host: '::1' })).toBe('http://[::1]:1439');
    // An empty custom host falls back to loopback rather than binding everything.
    expect(apiServerBindHost({ ...base, bind: 'custom', host: '' })).toBe('127.0.0.1');
  });

  it('refuses what it cannot serve safely', () => {
    expect(apiServerRefusal(base)).toBeNull();
    expect(apiServerRefusal({ ...base, token: '' })).toMatch(/token/i);
    expect(apiServerRefusal({ ...base, bind: 'custom', host: ' ' })).toMatch(/address/i);
    expect(apiServerRefusal({ ...base, advertisedUrl: 'nekko.local:1439' })).toMatch(/full URL/);
  });
});

describe('mcp entries', () => {
  it('is the portable npx form, with no env, when there is nothing to point at', () => {
    expect(mcpServerEntry('', '')).toEqual({ command: 'npx', args: ['-y', 'nekko-agent', 'mcp'] });
  });

  it('names the installed launcher and carries the address and token', () => {
    expect(mcpServerEntry('http://127.0.0.1:1439', 'abc', 'C:/bin/nekko-agent.cmd')).toEqual({
      command: 'C:/bin/nekko-agent.cmd',
      args: ['mcp'],
      env: { NEKKO_URL: 'http://127.0.0.1:1439', NEKKO_TOKEN: 'abc' },
    });
    expect(JSON.parse(apiServerMcpConfig('http://x:1', 'k')).mcpServers['nekko-agent'].env).toEqual({
      NEKKO_URL: 'http://x:1',
      NEKKO_TOKEN: 'k',
    });
  });
});

describe('trimTrailingSlashes', () => {
  it('drops trailing slashes only, and backslashes when asked', () => {
    expect(trimTrailingSlashes('http://x:1///')).toBe('http://x:1');
    expect(trimTrailingSlashes(String.raw`C:\bin\\`, true)).toBe(String.raw`C:\bin`);
    expect(trimTrailingSlashes(String.raw`C:\bin\ `.trimEnd())).toBe(String.raw`C:\bin\ `.trimEnd());
    expect(trimTrailingSlashes('////')).toBe('');
  });

  it('stays fast on the input that makes the regex form quadratic', () => {
    const evil = '/'.repeat(200_000) + 'x';
    const t = Date.now();
    expect(trimTrailingSlashes(evil)).toBe(evil);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
