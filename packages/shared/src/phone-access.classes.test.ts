import { describe, expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import {
  PHONE_ACTIVITY_LIMIT,
  PHONE_ALWAYS_DENIED,
  PHONE_CHANGE_CHANNELS,
  PHONE_CHANGE_PROOF,
  PHONE_DENIED_FOR_NOW,
  PHONE_DENIED_FOREVER,
  PHONE_READ_CHANNELS,
  PhoneAccessError,
  phoneAccessPolicy,
  phoneAlwaysDenied,
  phoneChannelAllowed,
  phoneDeviceAccess,
} from './phone-access.js';

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

describe('phone access classes', () => {
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

  it('still refuses absolute-path files, the stack calls and the other terminal channels', () => {
    for (const c of [
      'file:read', 'file:write', 'dir:list', 'pr:continueStack', 'pr:linkStack',
      'terminal:run', 'terminal:update', 'terminal:shells', 'terminal:snapshot', 'terminals:list:native',
      'terminal:attach', 'terminal:detach',
    ]) {
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
});
