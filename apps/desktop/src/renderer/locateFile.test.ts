import { describe, expect, it } from 'vitest';
import { fileListed, locateMovedFile, type ListDir } from './locateFile.js';

/** A pretend disk: folder to the names in it (a name ending in / is a folder). */
function disk(tree: Record<string, string[]>): ListDir {
  return async (path) => {
    const at = path.replaceAll('\\', '/').replace(/\/+$/, '');
    const names = tree[at];
    if (!names) throw new Error('ENOENT');
    return names.map((n) => ({ name: n.replace(/\/$/, ''), path: `${at}/${n.replace(/\/$/, '')}`, dir: n.endsWith('/') }));
  };
}

const code = disk({
  'C:/code': ['nekko-agent/', 'floop/', 'notes.md'],
  'C:/code/nekko-agent': ['nekko-designs/', 'apps/', '.worktrees/'],
  'C:/code/nekko-agent/nekko-designs': ['cloud-welcome-walkthrough-design-v3.html', 'older/'],
  'C:/code/nekko-agent/nekko-designs/older': ['models-page-design.html'],
  'C:/code/nekko-agent/.worktrees': ['live/'],
  'C:/code/nekko-agent/.worktrees/live/nekko-designs': ['wip-design.html'],
  'C:/code/floop': ['nekko-designs/'],
  'C:/code/floop/nekko-designs': ['board-design.html'],
});

describe('finding a file that is not where its link says (#3210)', () => {
  it('knows whether a folder lists a file, and treats a folder that is gone as not listing it', async () => {
    expect(await fileListed('C:/code/nekko-agent/nekko-designs/cloud-welcome-walkthrough-design-v3.html', code)).toBe(true);
    expect(await fileListed('C:\\code\\nekko-agent\\nekko-designs\\CLOUD-welcome-walkthrough-design-v3.html', code)).toBe(true);
    expect(await fileListed('C:/code/cloud-welcome-walkthrough-design-v3.html', code)).toBe(false);
    expect(await fileListed('C:/code/nekko-agent/.worktrees/gone/nekko-designs/a.html', code)).toBe(false);
    expect(await fileListed('loose.html', code)).toBeNull();
  });

  it('finds a design named by its bare name in a project one level inside the chat folder', async () => {
    expect(await locateMovedFile('C:/code/cloud-welcome-walkthrough-design-v3.html', code)).toBe('C:/code/nekko-agent/nekko-designs/cloud-welcome-walkthrough-design-v3.html');
    expect(await locateMovedFile('C:/code/models-page-design.html', code)).toBe('C:/code/nekko-agent/nekko-designs/older/models-page-design.html');
    expect(await locateMovedFile('C:/code/board-design.html', code)).toBe('C:/code/floop/nekko-designs/board-design.html');
  });

  it('follows a file from a removed worktree to the main checkout, or to its designs folder', async () => {
    expect(await locateMovedFile('C:/code/nekko-agent/.worktrees/gone/nekko-designs/cloud-welcome-walkthrough-design-v3.html', code))
      .toBe('C:/code/nekko-agent/nekko-designs/cloud-welcome-walkthrough-design-v3.html');
    // A copy that was renamed into a subfolder of the main designs folder is still found by name.
    expect(await locateMovedFile('C:/code/nekko-agent/.worktrees/gone/nekko-designs/models-page-design.html', code))
      .toBe('C:/code/nekko-agent/nekko-designs/older/models-page-design.html');
  });

  it('finds nothing for a file that is nowhere, and never looks up source files by name', async () => {
    expect(await locateMovedFile('C:/code/never-made-design.html', code)).toBeNull();
    expect(await locateMovedFile('C:/code/notes-elsewhere.ts', code)).toBeNull();
  });
});
