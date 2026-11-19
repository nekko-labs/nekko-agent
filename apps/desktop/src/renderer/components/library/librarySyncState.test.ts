import { describe, expect, it } from 'vitest';
import type { LibrarySyncStatus } from '@nekko-agent/shared';
import type { ArtifactEntry } from '../../artifactsIndex.js';
import { fileSync, remoteEntries, syncFilesOf, syncKey, syncLabel, syncSummary } from './librarySyncState.js';

const entry = (path: string, over: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  path, title: path.split('/').pop()!, filename: path.split('/').pop()!, kind: 'doc', sessionId: 's1', sessionTitle: 'Quarterly', at: 1, source: 'written', ...over,
});
const design = entry('/p/nekko-designs/checkout-design-v2.html', {
  kind: 'design', title: 'Checkout design', sessionId: '', sessionTitle: 'Shop', source: 'folder',
  versions: [{ version: 1, path: '/p/nekko-designs/checkout-design.html' }, { version: 2, path: '/p/nekko-designs/checkout-design-v2.html' }],
});
const status = (files: LibrarySyncStatus['files'], on = true): LibrarySyncStatus => ({ on, files, remote: [] });

describe('Library sync', () => {
  it('tells the engine every local file, each version of a design included, never another computer’s', () => {
    const remote = remoteEntries([{ id: 'o', deviceId: 'd', device: 'Desk', path: 'C:\\cloud\\library\\k\\a.md', originalPath: '/a.md', title: 'A', kind: 'doc', chat: 'Q', modifiedAt: 5, size: 3 }]);
    const files = syncFilesOf([entry('/p/report.md'), design, ...remote]);
    expect(files).toEqual([
      { path: '/p/report.md', title: 'report.md', kind: 'doc', chat: 'Quarterly' },
      { path: '/p/nekko-designs/checkout-design.html', title: 'Checkout design', kind: 'design', chat: 'Shop designs folder' },
      { path: '/p/nekko-designs/checkout-design-v2.html', title: 'Checkout design', kind: 'design', chat: 'Shop designs folder' },
    ]);
    expect(syncKey(files)).toBe(syncKey([...files]));
    expect(syncKey(files)).not.toBe(syncKey(files.slice(1)));
  });

  it('lists another computer’s file under that computer, read-only', () => {
    const [r] = remoteEntries([{ id: 'o', deviceId: 'd', device: 'Desk', path: 'C:\\cloud\\library\\k\\q3.md', originalPath: '/a/q3.md', title: '', kind: 'nope', chat: 'Quarterly', modifiedAt: 5, size: 3 }]);
    expect(r).toMatchObject({ path: 'C:/cloud/library/k/q3.md', title: 'q3.md', filename: 'q3.md', kind: 'doc', sessionId: '', sessionTitle: 'Quarterly', source: 'cloud', device: 'Desk', at: 5 });
    expect(fileSync(status({}), r)).toBe('remote');
    expect(syncLabel('remote', 'Desk')).toContain('From Desk');
  });

  it('gives each file its cloud, and nothing when Library sync is not open', () => {
    const report = entry('/p/report.md');
    expect(fileSync(null, report)).toBeNull();
    expect(fileSync(undefined, report)).toBeNull();
    expect(fileSync(status({ '/p/report.md': 'synced' }, false), report)).toBe('off');
    expect(fileSync(status({ '/p/report.md': 'synced' }), report)).toBe('synced');
    expect(fileSync(status({}), report)).toBe('pending');
    expect(fileSync(status({ '/p/report.md': 'tooLarge' }), report)).toBe('tooLarge');
    // A design is backed up only when every version is, and shows the busiest state.
    const both = (a: LibrarySyncStatus['files'][string], b: LibrarySyncStatus['files'][string]) =>
      fileSync(status({ '/p/nekko-designs/checkout-design.html': a, '/p/nekko-designs/checkout-design-v2.html': b }), design);
    expect(both('synced', 'synced')).toBe('synced');
    expect(both('synced', 'syncing')).toBe('syncing');
    expect(both('pending', 'synced')).toBe('pending');
    expect(both('tooLarge', 'synced')).toBe('tooLarge');
  });

  it('sums Library up in one word', () => {
    const a = entry('/p/a.md'), b = entry('/p/b.md');
    expect(syncSummary(null, [a])).toBeNull();
    expect(syncSummary(status({}, false), [a])?.word).toBe('Not backed up');
    expect(syncSummary(status({}), [])).toBeNull();
    expect(syncSummary(status({ '/p/a.md': 'synced', '/p/b.md': 'synced' }), [a, b])).toMatchObject({ tone: 'success', word: 'Backed up' });
    expect(syncSummary(status({ '/p/a.md': 'syncing', '/p/b.md': 'pending' }), [a, b])?.word).toBe('Backing up 1 file');
    expect(syncSummary(status({ '/p/a.md': 'synced' }), [a, b])?.word).toBe('1 file waiting to back up');
    expect(syncSummary(status({ '/p/a.md': 'noRoom', '/p/b.md': 'synced' }), [a, b])).toMatchObject({ tone: 'warning', word: 'Nekko Cloud storage full' });
    expect(syncSummary(status({ '/p/a.md': 'tooLarge', '/p/b.md': 'synced' }), [a, b])).toMatchObject({ tone: 'warning', word: '1 file not backed up' });
  });
});
