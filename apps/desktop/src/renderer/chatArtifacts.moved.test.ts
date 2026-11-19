import { describe, expect, it } from 'vitest';
import { chatArtifacts } from './chatArtifacts.js';
import { knownPathFor, mainCheckoutPath, toolPaths } from './artifactPaths.js';

/** #3045: a reply names a file relatively, but the chat made it in another repo or a git worktree. */
describe('a relative name for a file the chat worked on elsewhere', () => {
  it('means the file the tools named, in another repo or a worktree, before the chat folder', () => {
    const known = ['C:/code/floop/.worktrees/board-drag/nekko-designs/task-details-design.html', 'C:/code/floop/README.md'];
    expect(chatArtifacts('It is at `nekko-designs/task-details-design.html`.', 'C:/code', known).map((a) => a.path))
      .toEqual(['C:/code/floop/.worktrees/board-drag/nekko-designs/task-details-design.html']);
    expect(chatArtifacts('It is at `nekko-designs/other-design.html`.', 'C:/code', known).map((a) => a.path))
      .toEqual(['C:/code/nekko-designs/other-design.html']);
    // With no chat folder at all, a known file still resolves.
    expect(chatArtifacts('See [the design](nekko-designs/task-details-design.html).', undefined, known).map((a) => a.path))
      .toEqual(['C:/code/floop/.worktrees/board-drag/nekko-designs/task-details-design.html']);
  });

  it('collects the absolute file paths every file tool named, newest last', () => {
    const paths = toolPaths([
      { id: 'u', role: 'user', content: 'x', createdAt: 0 },
      { id: 'a', role: 'assistant', content: '', createdAt: 1, toolCalls: [
        { id: '1', name: 'Grep', input: { pattern: 'x', path: 'C:\\code\\floop\\nekko-designs\\a.html' } },
        { id: '2', name: 'Grep', input: { pattern: 'x', path: 'C:\\code\\floop' } },
        { id: '3', name: 'read_file', input: { path: 'relative/b.md' } },
        { id: '4', name: 'Write', input: { file_path: '/r/out/c.png' } },
        { id: '5', name: 'Bash', input: { command: 'cat /r/d.html' } },
      ] },
    ]);
    expect(paths).toEqual(['C:/code/floop/nekko-designs/a.html', '/r/out/c.png']);
    expect(knownPathFor('out/c.png', paths)).toBe('/r/out/c.png');
    expect(knownPathFor('c.png', paths)).toBe('/r/out/c.png');
    expect(knownPathFor('/abs/c.png', paths)).toBeNull();
    expect(knownPathFor('other/c.png', paths)).toBeNull();
  });

  it('maps a worktree path to the main checkout', () => {
    expect(mainCheckoutPath('C:/code/floop/.worktrees/board-drag/nekko-designs/a.html')).toBe('C:/code/floop/nekko-designs/a.html');
    expect(mainCheckoutPath('/r/nekko-designs/a.html')).toBeNull();
  });
});
