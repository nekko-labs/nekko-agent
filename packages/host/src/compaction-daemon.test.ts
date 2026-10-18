import { describe, expect, it, vi } from 'vitest';

const calls: unknown[][] = [];
vi.mock('./engine/daemon.js', () => ({
  daemonOwns: (what: string) => what === 'compaction',
  daemonCall: () => async (channel: string, ...args: unknown[]) => {
    calls.push([channel, ...args]);
    return channel === 'chat:compact' ? { id: args[0], messages: [] } : null;
  },
}));
const { cancelSessionCompaction, compactSession, isSessionCompacting, observeCompaction } = await import('./compaction.js');

describe('compaction under a daemon that owns it', () => {
  it('sends compactions and cancels to the daemon', async () => {
    await expect(compactSession('s1', null)).resolves.toEqual({ id: 's1', messages: [] });
    await compactSession('s2', { newChat: true });
    await cancelSessionCompaction('s1');
    expect(calls).toEqual([
      ['chat:compact', 's1', null],
      ['chat:compact', 's2', { newChat: true }],
      ['chat:cancelCompaction', 's1'],
    ]);
  });

  it('follows the compaction events the daemon sends for isSessionCompacting', () => {
    expect(isSessionCompacting('s3')).toBe(false);
    observeCompaction({ type: 'compaction', sessionId: 's3', progress: { state: 'running', done: 0, total: 0, target: 'here' } });
    expect(isSessionCompacting('s3')).toBe(true);
    observeCompaction({ type: 'compaction', sessionId: 's3', progress: { state: 'cancelled', done: 0, total: 1, target: 'here' } });
    expect(isSessionCompacting('s3')).toBe(false);
    observeCompaction({ type: 'done', sessionId: 's3' } as never);
    expect(isSessionCompacting('s3')).toBe(false);
  });
});
