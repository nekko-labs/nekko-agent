import { describe, expect, it } from 'vitest';
import { ARCHIVE_RETENTION_DAYS, agentsToAutoComplete, archiveDaysLeft, archiveExpired, autoCompleteDays, isArchived } from './archive.js';

const DAY = 24 * 60 * 60 * 1000;

describe('auto-completing idle agents', () => {
  it('defaults to a month and accepts only the offered choices', () => {
    expect(autoCompleteDays(undefined)).toBe(30);
    expect(autoCompleteDays(0)).toBe(0);
    expect(autoCompleteDays(90)).toBe(90);
    expect(autoCompleteDays(45)).toBe(30);
  });
  it('picks idle, unpinned, top-level, idle agents and nothing for Never', () => {
    const now = 100 * DAY;
    const s = (id: string, idle: number, extra = {}) => ({ id, updatedAt: now - idle * DAY, ...extra });
    const all = [s('a', 31), s('b', 29), s('pin', 60, { pinned: true }), s('kid', 60, { parentSessionId: 'a' }), s('done', 60, { archivedAt: 1 }), s('busy', 60), s('noTime', 60, { updatedAt: 0 })];
    expect(agentsToAutoComplete(all, 30, now, (id) => id === 'busy')).toEqual(['a']);
    expect(agentsToAutoComplete(all, 0, now)).toEqual([]);
  });
});

describe('archive retention', () => {
  it('treats absent, null and zero as live', () => {
    expect(isArchived({})).toBe(false);
    expect(isArchived({ archivedAt: null })).toBe(false);
    expect(isArchived({ archivedAt: 0 })).toBe(false);
    expect(isArchived({ archivedAt: 1 })).toBe(true);
  });

  it('keeps expiry display helpers compatible without an expiry date', () => {
    const at = 1_000_000_000_000;
    expect(ARCHIVE_RETENTION_DAYS).toBe(Number.POSITIVE_INFINITY);
    expect(archiveDaysLeft(at, at)).toBe(Number.POSITIVE_INFINITY);
    expect(archiveDaysLeft(at, Number.MAX_SAFE_INTEGER)).toBe(Number.POSITIVE_INFINITY);
  });

  it('never expires archived chats automatically', () => {
    const at = 1_000_000_000_000;
    expect(archiveExpired({ archivedAt: at }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(archiveExpired({}, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
