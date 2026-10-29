import { describe, expect, it } from 'vitest';
import {
  PHONE_CHANNELS,
  PhoneAccessError,
  callFromPhone,
  phoneAccessPolicy,
  phoneAlwaysDenied,
  phoneChannelAllowed,
  phoneChannelClass,
} from './phone-access.js';
import { IpcChannels } from './ipc.js';
import {
  PHONE_TERMINAL,
  PHONE_TERMINAL_CHANNELS,
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
  it('opens exactly the named terminal channels, in their classes', () => {
    for (const c of PHONE_TERMINAL_CHANNELS) {
      expect(phoneChannelAllowed(c), c).toBe(true);
      expect((PHONE_CHANNELS as readonly string[]).includes(c), c).toBe(true);
    }
    expect(PHONE_TERMINAL_CHANNELS.map((c) => [c, phoneChannelClass(c)])).toEqual([
      ['ssh:hosts', 'read'],
      ['ssh:open', 'change'],
      ['terminal:close', 'change'],
      ['terminal:create', 'change'],
      ['terminal:resize', 'token'],
      ['terminal:signal', 'change'],
      ['terminal:tail', 'read'],
      ['terminal:write', 'token'],
      ['terminals:list', 'read'],
    ]);
    for (const c of ['terminal:run', 'terminal:update', 'terminal:shells', 'terminal:snapshot', 'terminal:attach', 'terminal:detach', 'terminals:list:native', 'terminal:future']) {
      expect(phoneAlwaysDenied(c), c).toBe(true);
    }
  });

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

  it('refuses an unfiltered terminal list', async () => {
    const dispatch = () => [];
    expect(await code(callFromPhone(dispatch, 'terminals:list', []))).toBe('value-invalid');
    expect(await code(callFromPhone(dispatch, 'terminals:list', [{}]))).toBe('value-invalid');
    expect(await code(callFromPhone(dispatch, 'terminals:list', [{ sessionId: 's1' }]))).toBe('ok');
  });

  it('starts a new terminal in the chat folder, never a path the phone names', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const dispatch = (channel: string, args: unknown[]) => {
      calls.push([channel, args]);
      if (channel === 'session:get') return { id: 's1', workspaceId: 'w1', messages: [] };
      return { id: 'term_9', title: 'zsh', cwd: '/Users/philip/code/app', shell: '/bin/zsh', running: true, sessionId: 's1' };
    };
    const out = await callFromPhone(dispatch, 'terminal:create', [{ sessionId: 's1', cols: 50, rows: 20 }]);
    expect(calls).toEqual([
      ['session:get', ['s1']],
      ['terminal:create', [{ sessionId: 's1', cols: 50, rows: 20, workspaceId: 'w1' }]],
    ]);
    expect(out).toEqual({ id: 'term_9', title: 'zsh', kind: 'shell', folder: 'app', shell: 'zsh', running: true, sessionId: 's1', viewers: 0 });
    expect(await code(callFromPhone(dispatch, 'terminal:create', [{ sessionId: 's1', cwd: '/' }]))).toBe('option-denied');
  });

  it('drops the token and caps the tail before the computer sees them', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const dispatch = (channel: string, args: unknown[]) => {
      calls.push([channel, args]);
      return null;
    };
    await callFromPhone(dispatch, 'terminal:write', ['term_1', 'ls\r', 'tok']);
    await callFromPhone(dispatch, 'terminal:resize', ['term_1', 90, 30, 'tok']);
    await callFromPhone(dispatch, 'terminal:tail', ['term_1', 1 << 30]);
    expect(calls).toEqual([
      ['terminal:write', ['term_1', 'ls\r']],
      ['terminal:resize', ['term_1', 90, 30]],
      ['terminal:tail', ['term_1', PHONE_TERMINAL.tailBytes]],
    ]);
    expect(await code(callFromPhone(dispatch, 'terminal:write', ['term_1', 'ls\r']))).toBe('token-required');
  });

  it('shows a terminal without paths and SSH hosts without user names', () => {
    const t = phoneTerminalView({ id: 't', title: 'x', cwd: '/home/philip/secret-project', shell: '/opt/homebrew/bin/fish', running: true, viewers: [{ id: 'phone-2', name: 'Other phone' }] });
    expect(JSON.stringify(t)).not.toContain('/home');
    expect(JSON.stringify(t)).not.toContain('Other phone');
    expect(t).toMatchObject({ folder: 'secret-project', shell: 'fish', viewers: 1 });
    expect(phoneSshHostsView([{ alias: 'a', hostName: 'h', user: 'root', port: 22 }])).toEqual([{ alias: 'a', hostName: 'h', port: 22 }]);
  });
});
