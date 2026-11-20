import { describe, expect, it } from 'vitest';
import type { CloudStatus } from '@nekko-agent/shared';
import { syncOn } from './useSyncOn.js';

const status = (sync: Partial<CloudStatus['sync']>, signedIn = true) => ({ signedIn, sync: { phase: 'idle', enabled: true, ...sync } }) as CloudStatus;

describe("a chat's Sync switch shows only while this computer syncs chats", () => {
  it('needs sync on and set up', () => {
    expect(syncOn(status({}))).toBe(true);
    expect(syncOn(status({ enabled: false }))).toBe(false);
    expect(syncOn(status({ phase: 'paused' }))).toBe(false);
    expect(syncOn(status({}, false))).toBe(false);
    expect(syncOn(null)).toBe(false);
  });

  it('hides while Chats is turned off under What syncs (#3089), and an older engine means on', () => {
    expect(syncOn(status({ kinds: { chats: false, library: true } }))).toBe(false);
    expect(syncOn(status({ kinds: { chats: true, library: false } }))).toBe(true);
    expect(syncOn(status({ kinds: undefined }))).toBe(true);
  });
});
