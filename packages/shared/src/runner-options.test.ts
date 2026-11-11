import { describe, expect, it } from 'vitest';
import { runnerOptions, runnerUnavailable } from './runner-options.js';

const mac = { platform: 'darwin', arch: 'arm64' };
const intelMac = { platform: 'darwin', arch: 'x64' };
const pc = { platform: 'win32', arch: 'x64' };
const linuxPc = { platform: 'linux', arch: 'x64' };

const answers = (host: Parameters<typeof runnerOptions>[0], engine: boolean, guests?: Parameters<typeof runnerOptions>[2]) =>
  Object.fromEntries(runnerOptions(host, engine, guests).map((o) => [o.kind, o.available ? 'ok' : o.detail]));

describe('runner options', () => {
  it('lists every kind in the same order everywhere', () => {
    for (const h of [mac, intelMac, pc, linuxPc, null]) expect(runnerOptions(h, false).map((o) => o.kind)).toEqual(['macos', 'linux', 'windows']);
  });

  it('an_apple_silicon_mac_runs_macos_and_linux', () => {
    expect(answers(mac, true)).toEqual({ macos: 'ok', linux: 'ok', windows: 'Needs a Windows PC' });
    expect(runnerOptions(mac, true)[0].detail).toBe('Xcode, iOS and Mac jobs in a throwaway macOS VM');
  });

  it('a_mac_whose_service_has_no_runner_channels_says_to_update', () => {
    expect(answers(mac, false)).toEqual({ macos: 'Update Nekko Agent on this Mac to run it', linux: 'Update Nekko Agent on this Mac to run it', windows: 'Needs a Windows PC' });
  });

  it('apple_options_are_disabled_off_apple_silicon', () => {
    expect(answers(pc, false)).toEqual({ macos: 'Needs a Mac with Apple silicon', linux: 'Coming to Windows PCs', windows: 'Coming to Windows PCs' });
    expect(answers(intelMac, true)).toEqual({ macos: 'Needs a Mac with Apple silicon', linux: 'Needs a Mac with Apple silicon', windows: 'Needs a Windows PC' });
    expect(answers(linuxPc, false)).toEqual({ macos: 'Needs a Mac with Apple silicon', linux: 'Coming to Linux PCs', windows: 'Needs a Windows PC' });
  });

  it('an_unknown_computer_never_offers_macos', () => {
    expect(runnerUnavailable('macos', null, true)).toBe('Needs a Mac with Apple silicon');
  });

  it('guests_reported_by_the_daemon_win_over_the_platform', () => {
    // The Hyper-V engine (#2553) reports what it can run; macOS stays out on a PC whatever it says.
    expect(answers(pc, true, ['windows', 'linux'])).toEqual({ macos: 'Needs a Mac with Apple silicon', linux: 'ok', windows: 'ok' });
    expect(answers(pc, true, ['linux'])).toEqual({ macos: 'Needs a Mac with Apple silicon', linux: 'ok', windows: 'Coming to Windows PCs' });
  });
});
