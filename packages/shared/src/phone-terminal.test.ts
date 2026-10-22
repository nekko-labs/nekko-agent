import { describe, expect, it } from 'vitest';
import { PHONE_CHANNELS, PhoneAccessError, phoneAccessPolicy } from './phone-access.js';
import { IpcChannels } from './ipc.js';
import {
  PHONE_TERMINAL_LEAVE_CHANNEL,
  PHONE_TERMINAL_OPEN_CHANNEL,
  phoneSshHostsView,
  phoneTerminalView,
} from './phone-terminal.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).code;
  }
  return 'ok';
};

describe('terminals on a phone (IO-33 FA-3, FA-6)', () => {
  it('keeps the gate channels away from the host channels', () => {
    for (const c of [PHONE_TERMINAL_OPEN_CHANNEL, PHONE_TERMINAL_LEAVE_CHANNEL]) {
      expect(Object.values(IpcChannels)).not.toContain(c);
      expect((PHONE_CHANNELS as readonly string[]).includes(c), c).toBe(false);
    }
  });

  it('writes the limits into the policy file', () => {
    const p = phoneAccessPolicy();
    expect(p.tokenChannels).toEqual(['terminal:resize', 'terminal:write']);
    expect(p.terminal).toMatchObject({ tailBytes: 65536, tokenIdleMs: 300_000, tokenMaxMs: 1_800_000, eventBytes: 32768, eventWindowMs: 100, openChannel: 'terminal:open', leaveChannel: 'terminal:leave' });
  });

  it('shows a terminal without paths and SSH hosts without user names', () => {
    const t = phoneTerminalView({ id: 't', title: 'x', cwd: '/home/philip/secret-project', shell: '/opt/homebrew/bin/fish', running: true, viewers: [{ id: 'phone-2', name: 'Other phone' }] });
    expect(JSON.stringify(t)).not.toContain('/home');
    expect(JSON.stringify(t)).not.toContain('Other phone');
    expect(t).toMatchObject({ folder: 'secret-project', shell: 'fish', viewers: 1 });
    expect(phoneSshHostsView([{ alias: 'a', hostName: 'h', user: 'root', port: 22 }])).toEqual([{ alias: 'a', hostName: 'h', port: 22 }]);
  });
});
