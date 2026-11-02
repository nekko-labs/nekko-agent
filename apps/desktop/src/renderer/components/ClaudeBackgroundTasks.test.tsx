import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClaudeBackgroundTasks, claudeBackgroundLabel } from './ClaudeBackgroundTasks.js';

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
