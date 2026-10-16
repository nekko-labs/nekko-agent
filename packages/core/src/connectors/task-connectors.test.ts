import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CONNECTOR_CATALOG, isTaskConnector } from '@nekko-agent/shared';
import { asanaConnector, clickupConnector, CONNECTORS, parseTasksMarkdown, tasksFileConnector, todoistConnector, trelloConnector } from './index.js';

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

describe('task connectors', () => {
  let fetchMock: Mock;
  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as any; });

  it('every task-category kind has a connector', () => {
    const kinds = CONNECTOR_CATALOG.filter((c) => c.category === 'tasks').map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['linear', 'jira', 'trello', 'asana', 'todoist', 'clickup', 'tasksfile']));
    for (const k of kinds) expect(CONNECTORS[k]).toBeDefined();
    expect(isTaskConnector('slack')).toBe(false);
  });

  it('trello lists open cards with key + token and filters by query', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: 'c1', name: 'Ship it', desc: '', shortUrl: 'https://trello.com/c/1', due: '2025-05-01T00:00:00Z' }, { id: 'c2', name: 'Other' }]));
    const res = await trelloConnector.fetch('tok', 'ship', { key: 'k' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('key=k&token=tok');
    expect(res).toEqual([{ id: 'c1', title: 'Ship it', subtitle: 'Trello card · due 2025-05-01', url: 'https://trello.com/c/1', body: '' }]);
    await expect(trelloConnector.fetch('tok', undefined, {})).rejects.toThrow(/API key/);
  });

  it('asana finds the workspace then lists my incomplete tasks', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { workspaces: [{ gid: 'w1' }] } }));
    fetchMock.mockResolvedValueOnce(ok({ data: [{ gid: 't1', name: 'Write spec', permalink_url: 'u', due_on: '2025-06-01' }] }));
    const res = await asanaConnector.fetch('pat');
    expect(String(fetchMock.mock.calls[1][0])).toContain('assignee=me&workspace=w1&completed_since=now');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer pat');
    expect(res[0]).toMatchObject({ id: 't1', title: 'Write spec', subtitle: 'Asana task · due 2025-06-01' });
  });

  it('todoist reads paginated v1 results', async () => {
    fetchMock.mockResolvedValueOnce(ok({ results: [{ id: '9', content: 'Buy milk', description: 'x', due: { date: '2025-01-02' } }] }));
    const res = await todoistConnector.fetch('t');
    expect(res[0]).toMatchObject({ id: '9', title: 'Buy milk', subtitle: 'Todoist · due 2025-01-02', url: 'https://app.todoist.com/app/task/9' });
  });

  it('clickup sends the bare token and resolves the team', async () => {
    fetchMock.mockResolvedValueOnce(ok({ teams: [{ id: 42 }] }));
    fetchMock.mockResolvedValueOnce(ok({ tasks: [{ id: 'a', name: 'Fix', status: { status: 'open' }, url: 'u' }] }));
    const res = await clickupConnector.fetch('pk_1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('pk_1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/team/42/task');
    expect(res[0]).toMatchObject({ title: 'Fix', subtitle: 'ClickUp · open' });
  });
});

describe('tasks file', () => {
  const md = '# Now\n- [ ] Open task\n- [x] Done task\n## Later\n  * [ ] Nested later\nnot a task\n';

  it('keeps open checklist items under their heading', () => {
    expect(parseTasksMarkdown(md, '/t/TASKS.md')).toEqual([
      { id: '/t/TASKS.md:2', title: 'Open task', subtitle: 'Now', url: 'file:///t/TASKS.md', body: '' },
      { id: '/t/TASKS.md:5', title: 'Nested later', subtitle: 'Later', url: 'file:///t/TASKS.md', body: '' },
    ]);
  });

  it('reads the file from settings.path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
    const path = join(dir, 'TASKS.md');
    writeFileSync(path, md);
    expect((await tasksFileConnector.fetch('', undefined, { path })).map((t) => t.title)).toEqual(['Open task', 'Nested later']);
    await expect(tasksFileConnector.fetch('', undefined, {})).rejects.toThrow(/Markdown file/);
  });
});
