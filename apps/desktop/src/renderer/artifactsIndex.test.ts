import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSummary } from '@nekko-agent/shared';
import { artifactCandidates, artifactKind, folderDesigns, groupArtifacts, mergeArtifacts, readDesignsFolder, sessionArtifacts, withFolderDesigns } from './artifactsIndex.js';

const msg = (id: string, content: string, createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, createdAt, ...extra });
const write = (path: string) => ({ id: path, name: 'write_file', input: { path, content: 'x' } });
/** A file written by Claude Code, as its chats record it. */
const claudeWrite = (file_path: string) => ({ id: file_path, name: 'Write', input: { file_path, content: 'x' }, executedBy: 'claude-code' as const });

describe('artifacts index', () => {
  it('sorts files into kinds, with design folders winning for pages and images', () => {
    expect(artifactKind('C:/p/reports/audit.md')).toBe('doc');
    expect(artifactKind('/p/reports/dash.html')).toBe('web');
    expect(artifactKind('/p/nekko-designs/login/index.html')).toBe('design');
    expect(artifactKind('/p/nekko-designs/hero.svg')).toBe('design');
    expect(artifactKind('/p/docs/flow.mmd')).toBe('diagram');
    expect(artifactKind('/p/out.csv')).toBe('data');
    expect(artifactKind('/p/plan.xlsx')).toBe('office');
    expect(artifactKind('/p/src/index.ts')).toBeNull();
  });

  it('files a page or image as a design when its own name says so, wherever it sits', () => {
    for (const path of [
      '/p/reports/ios-connection-strip-design.html', '/p/.scratch/provider-import-mockup.html', '/p/reports/library-layouts/prototype.html',
      '/tmp/agent-plan-concepts.html', '/p/out/checkout_wireframe.png', '/p/reports/Login Mock-up.svg', '/p/docs/onboarding.canvas.html',
    ]) expect(artifactKind(path), path).toBe('design');
    // The word has to stand alone in the name, and only pages and images are designs.
    expect(artifactKind('/p/reports/redesigned-dashboard.html')).toBe('web');
    expect(artifactKind('/p/reports/mockingbird.png')).toBe('image');
    expect(artifactKind('/p/reports/ci-runners-p4-design.md')).toBe('doc');
    expect(artifactKind('/p/reports/design-tokens.json')).toBe('data');
  });

  it('counts files Claude Code wrote, which name their path file_path', () => {
    const session = { id: 'c1', title: 'Connection strip', messages: [
      msg('a1', 'Design mock is done (`reports/ios-connection-strip-design.html`).', 10, { toolCalls: [
        claudeWrite('/proj/reports/ios-connection-strip-design.html'),
        claudeWrite('/proj/apps/ios/App/Views/ConnectionStrip.swift'),
        claudeWrite('/Users/me/.claude/projects/-proj/memory/note.md'),
        claudeWrite('/proj/notes/future-ideas.md'),
        // Reading or editing a file does not make it an output, and a Write with no path is ignored.
        { id: 'r', name: 'Read', input: { file_path: '/proj/reports/old.html' } },
        { id: 'e', name: 'Edit', input: { file_path: '/proj/reports/edited.html' } },
        { id: 'w', name: 'Write', input: { path: '/proj/reports/wrong-key.html' } },
      ] }),
    ] };
    const out = sessionArtifacts(session, '/proj');
    expect(out.map((e) => [e.path, e.kind, e.source])).toEqual([
      ['/proj/reports/ios-connection-strip-design.html', 'design', 'written'],
      ['/proj/notes/future-ideas.md', 'doc', 'written'],
    ]);
    expect(out[0]).toMatchObject({ title: 'Ios connection strip design', sessionId: 'c1', sessionTitle: 'Connection strip', at: 10 });
  });

  it('lists the designs in a project folder, keeping the chat for any a chat already produced', () => {
    const folder = folderDesigns('Shop', [
      { name: 'login.html', path: 'C:\\proj\\nekko-designs\\login.html' },
      { name: 'index.html', path: 'C:\\proj\\nekko-designs\\checkout\\index.html' },
      { name: 'hero.svg', path: 'C:\\proj\\nekko-designs\\hero.svg' },
      { name: 'notes.md', path: 'C:\\proj\\nekko-designs\\notes.md' },
      { name: 'tokens.json', path: 'C:\\proj\\nekko-designs\\tokens.json' },
    ]);
    expect(folder.map((e) => [e.path, e.title])).toEqual([
      ['C:/proj/nekko-designs/login.html', 'Login'], ['C:/proj/nekko-designs/checkout/index.html', 'Checkout'], ['C:/proj/nekko-designs/hero.svg', 'Hero'],
    ]);
    expect(folder[0]).toEqual({ path: 'C:/proj/nekko-designs/login.html', title: 'Login', filename: 'login.html', kind: 'design', sessionId: '', sessionTitle: 'Shop', at: 0, source: 'folder' });

    const chat = sessionArtifacts({ id: 's1', title: 'Login page', messages: [msg('a', '', 7, { toolCalls: [write('nekko-designs/Login.html')] })] }, 'C:/proj');
    const all = withFolderDesigns(chat, [...folder, ...folder]);
    expect(all.map((e) => [e.path, e.sessionId])).toEqual([
      ['C:/proj/nekko-designs/Login.html', 's1'], ['C:/proj/nekko-designs/checkout/index.html', ''], ['C:/proj/nekko-designs/hero.svg', ''],
    ]);
    // Chat-made designs lead their group; folder-only ones follow in the folder's order.
    expect(groupArtifacts(all)[0].items.map((e) => e.filename)).toEqual(['Login.html', 'index.html', 'hero.svg']);
    expect(groupArtifacts(all, 'shop').flatMap((g) => g.items.map((e) => e.filename))).toEqual(['index.html', 'hero.svg']);
  });

  it('reads a designs folder and one level below it, and treats a missing or unreadable folder as empty', async () => {
    const tree: Record<string, Array<{ name: string; path: string; dir: boolean }>> = {
      '/proj/nekko-designs': [
        { name: 'checkout', path: '/proj/nekko-designs/checkout', dir: true },
        { name: 'locked', path: '/proj/nekko-designs/locked', dir: true },
        { name: 'login.html', path: '/proj/nekko-designs/login.html', dir: false },
      ],
      '/proj/nekko-designs/checkout': [
        { name: 'deeper', path: '/proj/nekko-designs/checkout/deeper', dir: true },
        { name: 'index.html', path: '/proj/nekko-designs/checkout/index.html', dir: false },
      ],
    };
    const asked: string[] = [];
    const listDir = async (path: string) => {
      asked.push(path);
      if (path.endsWith('/locked')) throw new Error('EACCES');
      return tree[path] ?? [];
    };
    expect((await readDesignsFolder(listDir, '/proj/')).map((e) => e.path)).toEqual(['/proj/nekko-designs/login.html', '/proj/nekko-designs/checkout/index.html']);
    // Two levels at most: the folder itself and its direct subfolders.
    expect(asked).toEqual(['/proj/nekko-designs', '/proj/nekko-designs/checkout', '/proj/nekko-designs/locked']);
    expect(await readDesignsFolder(listDir, 'C:\\other')).toEqual([]);
    expect(asked.at(-1)).toBe('C:\\other/nekko-designs');
    // A bridge that answers with nothing (a remote or partial one) is an empty folder, not a crash.
    expect(await readDesignsFolder(async () => null as never, '/proj')).toEqual([]);
  });

  it('collects linked documents and written outputs, not source files', () => {
    const session = { id: 's1', title: 'Audit', messages: [
      msg('a1', '', 10, { toolCalls: [write('reports/audit.md'), write('src/app.html'), write('package.json'), write('nekko-designs/login.html')] }),
      msg('a2', 'See [Disk audit](reports/audit.md) and [the diagram](docs/flow.mmd).', 20),
      { id: 'u', role: 'user' as const, content: '[mine](reports/user.md)', createdAt: 30 },
    ] };
    const out = sessionArtifacts(session, 'C:/proj');
    const byPath = Object.fromEntries(out.map((e) => [e.path, e]));
    expect(Object.keys(byPath).sort()).toEqual(['C:/proj/nekko-designs/login.html', 'C:/proj/reports/audit.md']);
    // The link's label and newer timestamp win over the written file's derived title.
    expect(byPath['C:/proj/reports/audit.md']).toMatchObject({ title: 'Disk audit', source: 'linked', at: 20, kind: 'doc', sessionId: 's1', sessionTitle: 'Audit' });
    expect(byPath['C:/proj/nekko-designs/login.html']).toMatchObject({ kind: 'design', source: 'written', title: 'Login' });
  });

  it('indexes image markdown and regular image links once per path across chats', () => {
    const old = sessionArtifacts({ id: 'old', title: 'Old images', messages: [
      msg('a1', '![Preview](reports/chart.png) [Open image](reports/./chart.png)', 10),
    ] }, 'C:/proj');
    expect(old).toEqual([{ path: 'C:/proj/reports/chart.png', title: 'Preview', filename: 'chart.png', kind: 'image', sessionId: 'old', sessionTitle: 'Old images', at: 10, source: 'linked' }]);

    const recent = sessionArtifacts({ id: 'new', title: 'New images', messages: [
      msg('a2', '[Updated chart](reports/chart.png) ![Preview](reports/./chart.png)', 20),
    ] }, 'C:/proj');
    expect(recent).toHaveLength(1);
    const merged = mergeArtifacts([old, recent]);
    expect(merged).toEqual([{ ...old[0], title: 'Updated chart', sessionId: 'new', sessionTitle: 'New images', at: 20 }]);
    expect(groupArtifacts(merged)).toEqual([{ kind: { id: 'image', label: 'Images' }, items: merged }]);
  });

  it('skips relative writes with no folder to resolve against', () => {
    expect(sessionArtifacts({ id: 's', title: 't', messages: [msg('a', '', 1, { toolCalls: [write('reports/x.md')] })] })).toEqual([]);
  });

  it('keeps one entry per path, owned by the newest chat, and groups newest first', () => {
    const a = sessionArtifacts({ id: 'old', title: 'Old', messages: [msg('a', '[R](/r/report.md)', 1)] });
    const b = sessionArtifacts({ id: 'new', title: 'New', messages: [msg('a', '[R2](/r/report.md) [P](/r/page.html) [Q](/r/q.md)', 5)] });
    const merged = mergeArtifacts([a, b]);
    expect(merged.find((e) => e.path === '/r/report.md')?.sessionId).toBe('new');
    const groups = groupArtifacts(merged);
    expect(groups.map((g) => g.kind.id)).toEqual(['doc', 'web']);
    expect(groupArtifacts(merged, 'page').flatMap((g) => g.items.map((i) => i.filename))).toEqual(['page.html']);
  });

  it('scans top-level conversations only, newest first', () => {
    const s = (id: string, extra: Partial<SessionSummary>) => ({ id, updatedAt: 1, exchangeCount: 4, ...extra }) as SessionSummary;
    const picked = artifactCandidates([s('a', { updatedAt: 1 }), s('b', { updatedAt: 3 }), s('child', { parentSessionId: 'a' }), s('img', { chatType: 'image' }), s('empty', { exchangeCount: 1 }), s('inc', { incognito: true })]);
    expect(picked.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
