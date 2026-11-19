import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';
import { archivedDate, archivedInGroup } from './archivedChats.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({
  id, title: id, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionSummary;

describe('archivedDate', () => {
  const now = new Date(2026, 5, 1).getTime();
  it('omits the year inside the current year', () => {
    expect(archivedDate(new Date(2026, 11, 20).getTime(), now, 'en-US')).toBe('Dec 20');
  });
  it('includes the year for an earlier year', () => {
    expect(archivedDate(new Date(2025, 11, 15).getTime(), now, 'en-US')).toBe('Dec 15, 2025');
  });
});

describe('archivedInGroup', () => {
  it('lists only archived top-level chats of the group, newest first', () => {
    const sessions = [
      chat('a', { archivedAt: 10, workspaceId: 'p' }),
      chat('b', { archivedAt: 30, workspaceId: 'p' }),
      chat('c', { workspaceId: 'p' }),
      chat('d', { archivedAt: 20, workspaceId: 'q' }),
      chat('kid', { archivedAt: 40, workspaceId: 'p', parentSessionId: 'b' }),
    ];
    expect(archivedInGroup(sessions, 'p', (s) => s.workspaceId ?? '__none').map((s) => s.id)).toEqual(['b', 'a']);
  });
});
