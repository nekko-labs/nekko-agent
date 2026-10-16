import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@nekko-agent/shared';

const state: { settings: { connectors: ConnectorConfig[] } } = { settings: { connectors: [] } };
vi.mock('../store.js', () => ({ useStore: Object.assign((selector: (s: unknown) => unknown) => selector(state), { getState: () => ({ seedComposer: () => {} }) }) }));
import { connectedTaskSources, MonitorTasks, taskPrompt } from './MonitorTasks.js';

describe('Agent Monitor tasks', () => {
  it('shows only connected task systems, in catalog order', () => {
    expect(connectedTaskSources([
      { kind: 'tasksfile', connected: true },
      { kind: 'slack', connected: true },
      { kind: 'linear', connected: true },
      { kind: 'trello', connected: false },
    ])).toEqual(['linear', 'tasksfile']);
    expect(connectedTaskSources(undefined)).toEqual([]);
  });

  it('renders nothing until a task connector is connected', () => {
    state.settings.connectors = [{ kind: 'github', connected: true }];
    expect(renderToStaticMarkup(<MonitorTasks sessionId="s" />)).toBe('');
    state.settings.connectors = [{ kind: 'jira', connected: true }];
    const markup = renderToStaticMarkup(<MonitorTasks sessionId="s" />);
    expect(markup).toContain('data-monitor-tasks');
    expect(markup).toContain('Tasks');
    // One source: no source tabs.
    expect(markup).not.toContain('role="tablist"');
    state.settings.connectors.push({ kind: 'asana', connected: true });
    expect(renderToStaticMarkup(<MonitorTasks sessionId="s" />)).toContain('role="tablist"');
  });

  it('builds a composer prompt with link and details', () => {
    expect(taskPrompt('linear', { id: '1', title: 'ENG-1 Fix', url: 'https://l/1', body: ' notes ' }))
      .toBe('Work on this Linear task: ENG-1 Fix\nLink: https://l/1\nDetails:\nnotes');
  });
});
