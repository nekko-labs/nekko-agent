import { describe, expect, it } from 'vitest';
import { configFromEnv } from './index.js';

const TOKEN = 'a'.repeat(40);

describe('configuration', () => {
  it('needs a long token, and reads the rest from NEKKO_ARTIFACTS_*', () => {
    expect(() => configFromEnv({})).toThrow(/NEKKO_ARTIFACTS_TOKEN/);
    expect(() => configFromEnv({ NEKKO_ARTIFACTS_TOKEN: 'short' })).toThrow(/at least 32/);
    const c = configFromEnv({ NEKKO_ARTIFACTS_TOKEN: TOKEN, NEKKO_ARTIFACTS_MAX_MB: '5', NEKKO_ARTIFACTS_CONTENT_PORT: '8080' });
    expect(c).toMatchObject({ apiPort: 4500, contentPort: 8080, publicUrl: 'http://localhost:8080', limits: { maxArtifactBytes: 5 * 1024 * 1024 } });
    expect(() => configFromEnv({ NEKKO_ARTIFACTS_TOKEN: TOKEN, NEKKO_ARTIFACTS_MAX_FILES: '0' })).toThrow(/whole number/);
    expect(() => configFromEnv({ NEKKO_ARTIFACTS_TOKEN: TOKEN, NEKKO_ARTIFACTS_PUBLIC_URL: 'ftp://x' })).toThrow(/http/);
  });
});
