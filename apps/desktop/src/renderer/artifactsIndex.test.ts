import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSummary } from '@nekko-agent/shared';
import { artifactCandidates, artifactKind, groupArtifacts, mergeArtifacts, sessionArtifacts } from './artifactsIndex.js';

const msg = (id: string, content: string, createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, createdAt, ...extra });
const write = (path: string) => ({ id: path, name: 'write_file', input: { path, content: 'x' } });

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
