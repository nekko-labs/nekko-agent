import { describe, expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import {
  PHONE_ACTIVITY_LIMIT,
  PHONE_ALWAYS_DENIED,
  PHONE_CHANGE_CHANNELS,
  PHONE_CHANGE_PROOF,
  PHONE_CHANNELS,
  PHONE_DENIED_FOR_NOW,
  PHONE_DENIED_FOREVER,
  PHONE_KEY_CHANNEL,
  PHONE_READ_CHANNELS,
  PhoneAccessError,
  checkPhoneAccess,
  phoneAccessPolicy,
  phoneAlwaysDenied,
  phoneChannelAllowed,
  phoneChannelClass,
  phoneDeviceAccess,
} from './phone-access.js';
import { PUSH_TEST_CHANNEL } from './remote.js';

/** IO-33 foundation: access classes, per-device switches and the denied groups. */

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).code;
  }
  return 'ok';
};

/** What phones could call before IO-33: in neither class, so they decide as before. */
const BEFORE_IO33 = PHONE_CHANNELS.filter((c) => !PHONE_READ_CHANNELS.includes(c) && !PHONE_CHANGE_CHANNELS.includes(c));

describe('phone access classes', () => {
  it('leaves every channel phones had before IO-33 in neither class', () => {
    expect(BEFORE_IO33).toHaveLength(30);
    for (const c of BEFORE_IO33) expect(phoneChannelClass(c), c).toBeNull();
  });

  it('classes files and logs (FA-1, FA-5): saving is the only Change', () => {
    for (const c of ['files:list', 'files:search', 'files:read', 'logs:list', 'logs:read']) expect(phoneChannelClass(c), c).toBe('read');
    expect(phoneChannelClass('files:write')).toBe('change');
  });

  it('only classes channels a phone may call, each in one class', () => {
    for (const c of [...PHONE_READ_CHANNELS, ...PHONE_CHANGE_CHANNELS]) {
      expect((PHONE_CHANNELS as readonly string[]).includes(c), `${c} is classed but not in PHONE_CHANNELS`).toBe(true);
      expect(phoneAlwaysDenied(c), c).toBe(false);
    }
    for (const c of PHONE_READ_CHANNELS) expect(PHONE_CHANGE_CHANNELS.includes(c), c).toBe(false);
  });

  it('refuses a classed call when the device switch is off, and nothing else', () => {
    // The lists are empty until the feature PRs: check the rule with the
    // classes the TS reports, so it holds whatever they contain.
    const all = { read: true, change: true };
    for (const c of BEFORE_IO33) {
      expect(code(() => checkPhoneAccess(c, { read: false, change: false })), c).toBe('ok');
      expect(code(() => checkPhoneAccess(c, all)), c).toBe('ok');
    }
    for (const c of PHONE_READ_CHANNELS) {
      expect(code(() => checkPhoneAccess(c, { read: false, change: true }))).toBe('read-off');
      expect(code(() => checkPhoneAccess(c, { read: true, change: false }))).toBe('ok');
    }
    for (const c of PHONE_CHANGE_CHANNELS) {
      expect(code(() => checkPhoneAccess(c, { read: true, change: false }))).toBe('change-off');
      expect(code(() => checkPhoneAccess(c, { read: false, change: true }))).toBe('ok');
    }
  });

  it('reads a device with no switches as everything on', () => {
    expect(phoneDeviceAccess(undefined)).toEqual({ read: true, change: true });
    expect(phoneDeviceAccess({})).toEqual({ read: true, change: true });
    expect(phoneDeviceAccess({ access: {} })).toEqual({ read: true, change: true });
    expect(phoneDeviceAccess({ access: { change: false } })).toEqual({ read: true, change: false });
    expect(phoneDeviceAccess({ access: { read: false, change: true } })).toEqual({ read: false, change: true });
  });

  it('says the refusals the way the gate does', () => {
    expect(new PhoneAccessError('change-off', 'file:write').message).toBe('Not allowed from a paired phone (change-off): file:write');
    expect(new PhoneAccessError('proof-stale', 'file:write').message).toBe('Not allowed from a paired phone (proof-stale): file:write');
  });
});

describe('the always-denied list', () => {
  it('is the forever group plus the groups waiting on a feature, flattened', () => {
    const groups = [PHONE_DENIED_FOREVER, ...Object.values(PHONE_DENIED_FOR_NOW)];
    expect(new Set(PHONE_ALWAYS_DENIED.channels)).toEqual(new Set(groups.flatMap((g) => g.channels)));
    expect(new Set(PHONE_ALWAYS_DENIED.prefixes)).toEqual(new Set(groups.flatMap((g) => g.prefixes)));
    // No channel is in two groups, so deleting a group frees exactly its own.
    expect(PHONE_ALWAYS_DENIED.channels.length).toBe(new Set(PHONE_ALWAYS_DENIED.channels).size);
  });

  it('keeps forever what no phone should ever do (SPEC: Full phone access)', () => {
    for (const c of ['providers:save', 'providers:remove', 'providers:importCliAuth', 'connector:connect', 'data:wipe', 'settings:reset']) {
      expect(PHONE_DENIED_FOREVER.channels, c).toContain(c);
    }
    for (const p of ['remote:', 'oauth:', 'dialog:', 'update:', 'shell:']) expect(PHONE_DENIED_FOREVER.prefixes, p).toContain(p);
    // Remote access itself: the new desktop-only switches and activity too.
    for (const c of [IpcChannels.remoteSetAccess, IpcChannels.remoteActivity, IpcChannels.remotePair, IpcChannels.remoteRevoke]) {
      expect(phoneChannelAllowed(c), c).toBe(false);
    }
  });

  it('still refuses absolute-path files, git and terminals', () => {
    for (const c of ['file:read', 'file:write', 'dir:list', 'pr:action', 'pr:diff', 'workspace:gitStatus', 'terminal:create', 'terminals:list']) {
      expect(phoneChannelAllowed(c), c).toBe(false);
      expect(phoneAlwaysDenied(c), c).toBe(true);
    }
  });
});

describe('the policy file', () => {
  it('carries the classes, the proof rule, the key channel and the activity limit', () => {
    const p = phoneAccessPolicy();
    expect(p.readChannels).toEqual([...PHONE_READ_CHANNELS]);
    expect(p.changeChannels).toEqual([...PHONE_CHANGE_CHANNELS]);
    expect(p.changeProof).toEqual({ version: 'nekko-change-v1', maxAgeMs: 300_000, maxAheadMs: 60_000 });
    expect(PHONE_CHANGE_PROOF.maxAgeMs).toBe(5 * 60 * 1000);
    expect(p.keyChannel).toBe('device:registerKey');
    expect(p.activityLimit).toBe(PHONE_ACTIVITY_LIMIT);
  });

  it('keeps the gate channel out of the allowlist and away from the host channels', () => {
    // The computer's gate answers it itself, like push:test the relay agent answers.
    expect((PHONE_CHANNELS as readonly string[]).includes(PHONE_KEY_CHANNEL)).toBe(false);
    expect(Object.values(IpcChannels)).not.toContain(PHONE_KEY_CHANNEL);
    expect(PHONE_KEY_CHANNEL).not.toBe(PUSH_TEST_CHANNEL);
    expect(phoneAlwaysDenied(PHONE_KEY_CHANNEL)).toBe(false);
  });
});
