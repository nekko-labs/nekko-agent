import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSummary } from '@nekko-agent/shared';
import { folderDesigns, helperCandidates, mainCheckoutPath, movedPaths, readProjectDesignFolders, relocate, sessionArtifacts, withFolderDesigns } from './artifactsIndex.js';

const msg = (id: string, content: string, createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, createdAt, ...extra });
const claudeWrite = (file_path: string) => ({ id: file_path, name: 'Write', input: { file_path, content: 'x' }, executedBy: 'claude-code' as const });

/**
 * #3045: a chat handed a design to a helper agent, which wrote it in a git
 * worktree that was removed after merging; the chat only searched and read it,
 * and its reply named it relatively from a parent folder of the repo.
 */
describe('designs made out of sight', () => {
  const root = 'C:/Users/me/code';
  const tree = `${root}/floop/.worktrees/board-drag`;
  const grep = (path: string) => ({ id: `g${path}`, name: 'Grep', input: { pattern: 'x', path }, executedBy: 'claude-code' as const });
  const read = (file_path: string) => ({ id: `r${file_path}`, name: 'Read', input: { file_path }, executedBy: 'claude-code' as const });

  it('lists a design the chat only read, edited or searched, but not other files it read', () => {
    const out = sessionArtifacts({ id: 'p', title: 'Floop', messages: [
      msg('a', 'Checking the design.', 5, { toolCalls: [
        grep(`${tree}/nekko-designs/task-details-design.html`),
        read(`${tree}/nekko-designs/task-details-design.png`),
        read(`${tree}/.verify/2-mid-drag.png`),
        read(`${tree}/reports/notes.md`),
      ] }),
    ] }, root);
    expect(out.map((e) => [e.filename, e.kind, e.source])).toEqual([
      ['task-details-design.html', 'design', 'written'],
      // The design's picture stays listed, under Images (#3145).
      ['task-details-design.png', 'image', 'written'],
    ]);
  });

  it('resolves a relative name in a reply to where the chat worked, not its own folder', () => {
    const out = sessionArtifacts({ id: 'p', title: 'Floop', messages: [
      msg('a', '', 5, { toolCalls: [grep(`${tree}/nekko-designs/task-details-design.html`)] }),
      msg('b', 'The design is at `nekko-designs/task-details-design.html`.', 9),
    ] }, root);
    expect(out.map((e) => [e.path, e.source, e.at])).toEqual([[`${tree}/nekko-designs/task-details-design.html`, 'linked', 9]]);
    // With nothing the tools named, it still means the chat's folder.
    expect(sessionArtifacts({ id: 'q', title: 'Q', messages: [msg('b', 'See `nekko-designs/x.html`.', 1)] }, root).map((e) => e.path))
      .toEqual([`${root}/nekko-designs/x.html`]);
  });

  it('files what a helper agent wrote under the chat that started it', () => {
    const helper = { id: 'h', title: 'Design reworked task details view', messages: [
      msg('a', '', 3, { toolCalls: [claudeWrite(`${tree}/nekko-designs/task-details-design.html`), claudeWrite(`${tree}/nekko-designs/screenshot.mjs`)] }),
    ] };
    const out = sessionArtifacts(helper, root, { id: 'p', title: 'Floop' });
    expect(out.map((e) => [e.filename, e.sessionId, e.sessionTitle])).toEqual([['task-details-design.html', 'p', 'Floop']]);
    const s = (id: string, extra: Partial<SessionSummary>) => ({ id, updatedAt: 1, exchangeCount: 1, ...extra }) as SessionSummary;
    const parents = [s('p', { exchangeCount: 3 })];
    expect(helperCandidates([s('p', {}), s('h', { parentSessionId: 'p' }), s('orphan', { parentSessionId: 'gone' }), s('inc', { parentSessionId: 'p', incognito: true })], parents)
      .map((x) => [x.id, x.parent.id])).toEqual([['h', 'p']]);
  });

  it('judges a file in a .claude worktree by its path inside the repo', () => {
    const out = sessionArtifacts({ id: 'p', title: 'P', messages: [
      msg('a', '', 1, { toolCalls: [claudeWrite('/r/.claude/worktrees/w1/nekko-designs/a.html'), claudeWrite('/r/.claude/worktrees/w1/src/b.html')] }),
    ] }, '/r');
    expect(out.map((e) => e.filename)).toEqual(['a.html']);
  });

  it('follows a file from a removed worktree to the main checkout, and keeps the chat over the folder listing', async () => {
    expect(mainCheckoutPath(`${tree}/nekko-designs/a.html`)).toBe(`${root}/floop/nekko-designs/a.html`);
    expect(mainCheckoutPath('C:/r/.claude/worktrees/x/out/a.png'.replaceAll('/', String.fromCharCode(92)))).toBe('C:/r/out/a.png');
    expect(mainCheckoutPath('/r/.git/nekko-worktrees/x/a.html')).toBe('/r/a.html');
    expect(mainCheckoutPath('/r/nekko-designs/a.html')).toBeNull();

    const disk: Record<string, string[]> = { [`${root}/floop/nekko-designs`]: ['Task-details-design.html'] };
    const listDir = async (path: string) => { if (!disk[path]) throw new Error('ENOENT'); return disk[path].map((name) => ({ name })); };
    const moved = await movedPaths(listDir, [`${tree}/nekko-designs/task-details-design.html`, `${tree}/nekko-designs/gone.html`, '/plain/gone.html']);
    expect([...moved]).toEqual([[`${tree}/nekko-designs/task-details-design.html`.toLowerCase(), `${root}/floop/nekko-designs/task-details-design.html`]]);
    // A worktree that is still there keeps its own copy; one listed empty (the host's answer for a missing folder) has moved.
    const live: Record<string, string[]> = { ...disk, [`${root}/floop/.worktrees/open/nekko-designs`]: ['task-details-design.html'], [`${root}/floop/.worktrees/empty/nekko-designs`]: [] };
    const liveList = async (path: string) => { if (!live[path]) throw new Error('ENOENT'); return live[path].map((name) => ({ name })); };
    expect([...(await movedPaths(liveList, [
      `${root}/floop/.worktrees/open/nekko-designs/task-details-design.html`,
      `${root}/floop/.worktrees/empty/nekko-designs/task-details-design.html`,
    ])).values()]).toEqual([`${root}/floop/nekko-designs/task-details-design.html`]);

    const chat = sessionArtifacts({ id: 'p', title: 'Floop', messages: [msg('a', '', 5, { toolCalls: [grep(`${tree}/nekko-designs/task-details-design.html`)] })] }, root);
    const folder = folderDesigns('floop', [{ path: `${root}/floop/nekko-designs/task-details-design.html`, name: 'task-details-design.html' }]);
    const out = relocate(withFolderDesigns(chat, folder), moved);
    expect(out.map((e) => [e.path, e.sessionId])).toEqual([[`${root}/floop/nekko-designs/task-details-design.html`, 'p']]);
  });

  it('reads the designs folders of the repos inside a chat folder', async () => {
    const disk: Record<string, Array<{ name: string; dir: boolean }>> = {
      [root]: [{ name: 'floop', dir: true }, { name: 'node_modules', dir: true }, { name: '.git', dir: true }, { name: 'nekko-designs', dir: true }, { name: 'a.txt', dir: false }],
      [`${root}/nekko-designs`]: [{ name: 'scratch-design.html', dir: false }],
      [`${root}/floop/nekko-designs`]: [{ name: 'task-details-design.html', dir: false }],
    };
    const asked: string[] = [];
    const listDir = async (path: string) => {
      asked.push(path);
      if (!disk[path]) throw new Error('ENOENT');
      return disk[path].map((e) => ({ ...e, path: `${path}/${e.name}` }));
    };
    const found = await readProjectDesignFolders(listDir, { name: 'code', path: `${root}/` });
    expect(found.map((f) => [f.project, f.files.map((x) => x.name)])).toEqual([['code', ['scratch-design.html']], ['floop', ['task-details-design.html']]]);
    expect(asked).not.toContain(`${root}/node_modules/nekko-designs`);
    expect(asked).not.toContain(`${root}/.git/nekko-designs`);
  });
});
