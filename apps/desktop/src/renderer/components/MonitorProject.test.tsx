import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@nekko-agent/shared';
import { parseTasksMarkdown, pickProjectTaskFile } from '@nekko-agent/shared';

const state: { settings: { connectors: ConnectorConfig[] } } = { settings: { connectors: [] } };
vi.mock('../store.js', () => ({ useStore: Object.assign((selector: (s: unknown) => unknown) => selector(state), { getState: () => ({ seedComposer: () => {}, setView: () => {}, openFilePane: () => {} }) }) }));
import { connectedTaskSources, MonitorProject, taskPrompt } from './MonitorProject.js';

describe('Agent Monitor project group', () => {
  it('shows only connected task systems, in catalog order', () => {
    expect(connectedTaskSources([
      { kind: 'tasksfile', connected: true },
      { kind: 'slack', connected: true },
      { kind: 'linear', connected: true },
      { kind: 'trello', connected: false },
    ])).toEqual(['linear', 'tasksfile']);
    expect(connectedTaskSources(undefined)).toEqual([]);
  });

  it('always renders, pointing at connectors when there is no tracker and no repo', () => {
    state.settings.connectors = [{ kind: 'github', connected: true }];
    const empty = renderToStaticMarkup(<MonitorProject sessionId="s" />);
    expect(empty).toContain('data-monitor-project');
    expect(empty).toContain('data-project-source="none"');
    expect(empty).toContain('Connect Linear, Jira or Asana');
    expect(empty).not.toContain('TASKS.md');
    // With a repo folder, the hint also offers the file-based tracker.
    expect(renderToStaticMarkup(<MonitorProject sessionId="s" projectPath="/repo" />)).toContain('Loading tasks');
  });

  it('prefers a connected PM tool, one tab per source when there are several', () => {
    state.settings.connectors = [{ kind: 'jira', connected: true }];
    const markup = renderToStaticMarkup(<MonitorProject sessionId="s" projectPath="/repo" />);
    expect(markup).toContain('data-project-source="jira"');
    expect(markup).toContain('Project');
    expect(markup).toContain('Jira');
    expect(markup).not.toContain('role="tablist"');
    state.settings.connectors.push({ kind: 'asana', connected: true });
    expect(renderToStaticMarkup(<MonitorProject sessionId="s" />)).toContain('role="tablist"');
  });

  it('finds the repo task file by preference, case-insensitively', () => {
    expect(pickProjectTaskFile(['README.md', 'todo.md', 'TASKS.md'])).toBe('TASKS.md');
    expect(pickProjectTaskFile(['Roadmap.md', 'TODO.md'])).toBe('TODO.md');
    expect(pickProjectTaskFile(['README.md'])).toBeNull();
    expect(parseTasksMarkdown('## Now\n- [ ] Ship it\n- [x] Done', '/r/TASKS.md').map((t) => [t.title, t.subtitle])).toEqual([['Ship it', 'Now']]);
  });

  it('builds a composer prompt with link and details', () => {
    expect(taskPrompt('linear', { id: '1', title: 'ENG-1 Fix', url: 'https://l/1', body: ' notes ' }))
      .toBe('Work on this Linear task: ENG-1 Fix\nLink: https://l/1\nDetails:\nnotes');
    expect(taskPrompt('TASKS.md', { id: '1', title: 'Ship it' })).toBe('Work on this TASKS.md task: Ship it');
  });
});
