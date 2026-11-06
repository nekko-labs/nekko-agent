import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';
import { newScreenLayout, reusableEmptyChat, shouldStartFromEmptyWall } from './emptyWallStart.js';

const chat = (id: string, patch: Partial<SessionSummary> = {}) => ({ id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0, exchangeCount: 0, transcriptTokens: 0, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, ...patch }) as unknown as SessionSummary;

describe('empty wall new-chat screen', () => {
  it('reuses the newest untouched top-level chat', () => {
    expect(reusableEmptyChat([chat('old', { createdAt: 1 }), chat('new', { createdAt: 5 })])).toBe('new');
  });

  it('never reuses a used, queued, completed, image, sub-agent, automation or training chat', () => {
    expect(reusableEmptyChat([
      chat('used', { messageCount: 2 }),
      chat('queued', { queue: ['go'] }),
      chat('done', { archivedAt: 3 }),
      chat('image', { chatType: 'image' }),
      chat('child', { parentSessionId: 'p' }),
      chat('task', { taskId: 't' }),
      chat('train', { trainingRunId: 'r' }),
    ])).toBeNull();
  });

  it('opens a second window in its opener\'s mode, Dynamic at two panes', () => {
    const layout = { mode: 'grid' as const, cols: 3, rows: 2, fixedGrid: true };
    expect(newScreenLayout(layout, 'focus')).toEqual({ mode: 'focus', cols: 2, rows: 1, fixedGrid: false });
    expect(newScreenLayout(layout, 'grid')).toEqual({ mode: 'grid', cols: 2, rows: 1, fixedGrid: false });
  });

  it('starts only on a loaded, empty wall with a usable provider', () => {
    const ok = { listsReady: true, hasWindows: false, readingCompleted: false, providerReady: true };
    expect(shouldStartFromEmptyWall(ok)).toBe(true);
    expect(shouldStartFromEmptyWall({ ...ok, listsReady: false })).toBe(false);
    expect(shouldStartFromEmptyWall({ ...ok, hasWindows: true })).toBe(false);
    expect(shouldStartFromEmptyWall({ ...ok, readingCompleted: true })).toBe(false);
    expect(shouldStartFromEmptyWall({ ...ok, providerReady: false })).toBe(false);
  });
});
