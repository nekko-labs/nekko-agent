import { describe, expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import {
  PHONE_CHANGE_CHANNELS,
  PHONE_READ_CHANNELS,
  PhoneAccessError,
  callFromPhone,
  phoneAlwaysDenied,
  phoneChannelAllowed,
  phoneChannelClass,
  redactPhoneResult,
  screenPhoneCall,
} from './phone-access.js';
import { PHONE_GIT_CHANNELS, PHONE_GIT_VIEW } from './phone-git.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).code;
  }
  return 'ok';
};

const WS_CHANNELS = [
  'workspace:gitStatus', 'git:diff', 'git:log', 'git:show', 'git:branches', 'git:compare', 'git:stage', 'git:unstage',
  'git:commit', 'git:commitMessage', 'git:push', 'git:switch', 'git:mergeAbort', 'pr:create',
];

/** Good arguments after the workspace id, per channel. */
const REST: Record<string, unknown[]> = {
  'git:show': ['HEAD'],
  'git:compare': ['main', 'feat'],
  'git:stage': [['a']],
  'git:unstage': [['a']],
  'git:commit': [{ message: 'm' }],
  'git:switch': ['feat'],
  'pr:create': [{ title: 't' }],
};

describe('git on a phone (IO-33 FA-2)', () => {
  it('classes reads and changes as decided', () => {
    expect(PHONE_READ_CHANNELS.filter((c) => PHONE_GIT_CHANNELS.includes(c)).sort()).toEqual(
      ['git:branches', 'git:compare', 'git:diff', 'git:log', 'git:show', 'pr:checks', 'pr:diff', 'workspace:gitStatus'].sort(),
    );
    expect(PHONE_CHANGE_CHANNELS.filter((c) => PHONE_GIT_CHANNELS.includes(c)).sort()).toEqual(
      ['git:commit', 'git:commitMessage', 'git:mergeAbort', 'git:push', 'git:stage', 'git:switch', 'git:unstage', 'pr:action', 'pr:create'].sort(),
    );
    // The model-written message spends tokens: a Change, so Face ID is asked.
    expect(phoneChannelClass('git:commitMessage')).toBe('change');
    for (const c of PHONE_GIT_CHANNELS) {
      expect(phoneChannelAllowed(c), c).toBe(true);
      expect(Object.values(IpcChannels), c).toContain(c);
    }
    // The stack calls restack several branches: still the desktop's.
    for (const c of ['pr:continueStack', 'pr:linkStack']) expect(phoneAlwaysDenied(c), c).toBe(true);
  });

  it('only reaches a chat folder, never a saved folder by id', () => {
    for (const c of WS_CHANNELS) {
      const rest = REST[c] ?? [];
      expect(code(() => screenPhoneCall(c, ['session:s1', ...rest])), c).toBe('ok');
      for (const ws of ['w1', 'session:', '', null, 1, { id: 'session:s1' }]) {
        expect(code(() => screenPhoneCall(c, [ws, ...rest])), `${c} ${JSON.stringify(ws)}`).toBe('value-invalid');
      }
    }
  });

  it('passes only the checked fields to the computer', async () => {
    const calls: unknown[][] = [];
    const dispatch = (channel: string, args: unknown[]) => {
      calls.push([channel, args]);
      return { ok: true, message: 'done' };
    };
    await callFromPhone(dispatch, 'git:push', ['session:s1', { setUpstream: true }]);
    await callFromPhone(dispatch, 'workspace:gitStatus', ['session:s1']);
    await callFromPhone(dispatch, 'pr:action', ['https://github.com/o/r/pull/1', 'approve']);
    expect(calls).toEqual([
      ['git:push', ['session:s1', { setUpstream: true }]],
      ['workspace:gitStatus', ['session:s1', false]],
      ['pr:action', ['https://github.com/o/r/pull/1', 'approve']],
    ]);
    await expect(callFromPhone(dispatch, 'git:push', ['session:s1', { force: true }])).rejects.toThrow('(option-denied): force');
    expect(calls).toHaveLength(3);
  });

  it('keeps a whole answer under the byte cap', () => {
    const line = 'x'.repeat(1000);
    const patch = ['@@ -0,0 +1,200 @@', ...Array.from({ length: 200 }, () => `+${line}`)].join('\n');
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, status: 'added', additions: 200, deletions: 0, patch }));
    const view = redactPhoneResult('git:diff', { files, truncated: false }) as { files: Array<{ patch: string; truncated?: boolean }>; truncated: boolean };
    const bytes = view.files.reduce((n, f) => n + new TextEncoder().encode(f.patch).length, 0);
    expect(bytes).toBeLessThanOrEqual(PHONE_GIT_VIEW.totalBytes);
    expect(view.files[0].patch).toBe(patch);
    expect(view.files.slice(1).some((f) => f.patch === '' && f.truncated)).toBe(true);
    expect(view.truncated).toBe(true);
    expect(view.files).toHaveLength(5);
  });

  it('never sends an email, a worktree path or a secret file’s patch', () => {
    const c = { sha: 'a', short: 'a', parents: [], author: 'Ada', email: 'ada@example.com', date: 'd', subject: 's' };
    const all = JSON.stringify([
      redactPhoneResult('git:log', [c]),
      redactPhoneResult('git:show', { commit: { ...c, body: '' }, files: [{ path: 'id_rsa', status: 'added', additions: 1, deletions: 0, patch: '+PRIVATE' }], truncated: false }),
      redactPhoneResult('git:commit', { ok: true, message: '', commit: c }),
      redactPhoneResult('git:compare', { base: 'a', head: 'b', ahead: 0, behind: 0, commits: [c], files: [], truncated: false }),
      redactPhoneResult('workspace:gitStatus', { workspaceId: 'session:s1', repo: true, worktree: { name: 'wt', path: '/Users/me/wt' } }),
    ]);
    expect(all).not.toContain('example.com');
    expect(all).not.toContain('/Users/me');
    expect(all).not.toContain('PRIVATE');
    expect(all).toContain('Ada');
    expect(all).toContain('"hidden":true');
  });
});
