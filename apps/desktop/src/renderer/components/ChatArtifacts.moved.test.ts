import { describe, expect, it } from 'vitest';
import { followMovedFile } from './ChatArtifacts.js';

/** #3045: a chat's card for a file whose git worktree was removed after merging. */
describe('a card for a file in a removed worktree', () => {
  it('follows it to the main checkout only when the worktree copy is gone and the main one is there', async () => {
    const disk: Record<string, string[]> = { 'C:/r/nekko-designs': ['a.html', 'b.html'], 'C:/r/.worktrees/live/nekko-designs': ['b.html'] };
    const listDir = async (path: string) => { if (!disk[path]) throw new Error('ENOENT'); return disk[path].map((name) => ({ name })); };
    expect(await followMovedFile('C:/r/.worktrees/gone/nekko-designs/a.html', listDir)).toBe('C:/r/nekko-designs/a.html');
    expect(await followMovedFile('C:/r/.worktrees/live/nekko-designs/b.html', listDir)).toBeNull();
    expect(await followMovedFile('C:/r/.worktrees/gone/nekko-designs/missing.html', listDir)).toBeNull();
    expect(await followMovedFile('C:/r/nekko-designs/a.html', listDir)).toBeNull();
  });
});
