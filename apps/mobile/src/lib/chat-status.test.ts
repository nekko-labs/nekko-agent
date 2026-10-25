import { describe, expect, it } from 'vitest';
import { remoteChatStatus } from './chat-status';

describe('remote chat status', () => {
  it('treats missing host watch counts as zero for older hosts', () => {
    expect(remoteChatStatus({})).toBe('done');
    expect(remoteChatStatus({ activeWatchCount: undefined })).toBe('done');
  });

  it('shows done without an armed watch and idle with one or more', () => {
    expect(remoteChatStatus({ activeWatchCount: 0 })).toBe('done');
    expect(remoteChatStatus({ activeWatchCount: 1 })).toBe('idle');
    expect(remoteChatStatus({ activeWatchCount: 3 })).toBe('idle');
  });

  it.each([undefined, 0, 1, 3])('preserves working and input with watch count %s', (activeWatchCount) => {
    expect(remoteChatStatus({ activeWatchCount }, 'running')).toBe('running');
    expect(remoteChatStatus({ activeWatchCount }, 'needs-you')).toBe('needs-you');
  });

  it('follows host watch updates and returns to inactivity after live work/input', () => {
    const summary = { activeWatchCount: 1 };
    expect(remoteChatStatus(summary, 'running')).toBe('running');
    expect(remoteChatStatus(summary, 'needs-you')).toBe('needs-you');
    expect(remoteChatStatus(summary)).toBe('idle');
    expect(remoteChatStatus({ ...summary, activeWatchCount: 0 })).toBe('done');
  });
});
