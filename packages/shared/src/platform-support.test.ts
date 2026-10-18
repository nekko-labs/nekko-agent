import { describe, expect, it } from 'vitest';
import { unsupportedPlatformReason } from './platform-support.js';

describe('platform support', () => {
  it('refuses Intel Macs and says what still works', () => {
    expect(unsupportedPlatformReason('darwin', 'x64')).toMatch(/Apple silicon/);
    expect(unsupportedPlatformReason('darwin', 'x64')).toMatch(/--url/);
  });
  it('runs where there is a nekkod build: Apple silicon, Windows (Arm through x64) and Linux', () => {
    for (const [p, a] of [['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
      expect(unsupportedPlatformReason(p, a)).toBeNull();
    }
  });
  it('refuses a platform with no engine build, naming it', () => {
    for (const [p, a] of [['freebsd', 'x64'], ['linux', 'ia32'], ['win32', 'ia32'], ['linux', 'riscv64']]) {
      expect(unsupportedPlatformReason(p, a)).toMatch(new RegExp(`no build for ${p} ${a}.*--url`));
    }
  });
});
