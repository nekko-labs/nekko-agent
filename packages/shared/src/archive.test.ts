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

  it('counts whole days left, rounding a partial day up', () => {
    const at = 1_000_000_000_000;
    expect(archiveDaysLeft(at, at)).toBe(ARCHIVE_RETENTION_DAYS);
    expect(archiveDaysLeft(at, at + DAY)).toBe(ARCHIVE_RETENTION_DAYS - 1);
    expect(archiveDaysLeft(at, at + (ARCHIVE_RETENTION_DAYS - 1) * DAY + 1)).toBe(1);
    expect(archiveDaysLeft(at, at + ARCHIVE_RETENTION_DAYS * DAY + 5)).toBe(0);
  });

  it('expires only archived chats past the window', () => {
    const at = 1_000_000_000_000;
    expect(archiveExpired({ archivedAt: at }, at + (ARCHIVE_RETENTION_DAYS * DAY) - 1)).toBe(false);
    expect(archiveExpired({ archivedAt: at }, at + ARCHIVE_RETENTION_DAYS * DAY)).toBe(true);
    expect(archiveExpired({}, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
