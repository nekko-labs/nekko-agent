import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackgroundWork, ClaudeBackgroundTasks, backgroundWorkHeading, claudeBackgroundLabel } from './ClaudeBackgroundTasks.js';

describe('Claude Code background tasks', () => {
  it('says how many tasks still run after the turn, as a status line', () => {
    const html = renderToStaticMarkup(<ClaudeBackgroundTasks tasks={1} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('still running 1 background task.');
    expect(claudeBackgroundLabel(2)).toBe('Claude Code is still running 2 background tasks');
  });
  it('shows nothing when none run', () => {
    expect(renderToStaticMarkup(<ClaudeBackgroundTasks tasks={0} />)).toBe('');
  });
});

describe('Background work under a finished turn (#2840)', () => {
  const agents = [
    { id: 's_a', title: 'Triage issues 1635-1776', detail: 'Running Bash: gh issue view 1644' },
    { id: 's_b', title: 'Fix #1909 narrow Agents drawer', detail: 'Thinking through the task.' },
  ];

  it('lists each working sub-agent with what it is doing, and opens it', () => {
    const html = renderToStaticMarkup(<BackgroundWork tasks={2} agents={agents} />);
    expect(html).toContain('Waiting on 2 sub-agents');
    expect(html).toContain('Triage issues 1635-1776');
    expect(html).toContain('Running Bash: gh issue view 1644');
    expect(html).toContain('data-background-agent="s_b"');
    expect(html).toContain('title="Open Fix #1909 narrow Agents drawer"');
    // Agents are counted once, not again as background tasks.
    expect(html).not.toContain('background task');
  });

  it('counts the other background work beside the sub-agents', () => {
    expect(backgroundWorkHeading(3, 1)).toBe('Waiting on 1 sub-agent and 2 other background tasks');
    expect(backgroundWorkHeading(1, 2)).toBe('Waiting on 2 sub-agents');
  });

  it('shows sub-agents before Claude Code has counted them', () => {
    expect(renderToStaticMarkup(<BackgroundWork tasks={0} agents={agents.slice(0, 1)} />)).toContain('Waiting on 1 sub-agent');
  });
});
