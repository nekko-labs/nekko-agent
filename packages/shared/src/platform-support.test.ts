import { describe, expect, it } from 'vitest';
import { unsupportedPlatformReason } from './platform-support.js';

describe('platform support', () => {
  it('refuses Intel Macs and says what still works', () => {
    expect(unsupportedPlatformReason('darwin', 'x64')).toMatch(/Apple silicon/);
    expect(unsupportedPlatformReason('darwin', 'x64')).toMatch(/--url/);
  });
  it('runs on Apple silicon, Windows and Linux', () => {
    for (const [p, a] of [['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
      expect(unsupportedPlatformReason(p, a)).toBeNull();
    }
  });
});
