import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyLiveActivity } from '@agent-nekko/shared';
import { MiniNekko } from '../Mascot.js';
import { replyIconState, ReplyStatus } from './ReplyStatus.js';

describe('reply status icon', () => {
  it('defaults to an empty face with only transient blink marks', () => {
    const markup = renderToStaticMarkup(<MiniNekko />);
    expect(markup).toContain('data-mini-state="idle"');
    expect(markup).toContain('nekko-mini-blink');
    expect(markup).not.toContain('M11 15H13V18H11Z');
    expect(markup).not.toContain('M15 20H17V21H15Z');
  });

  it.each(['bash', 'functions.bash', 'start_process', 'read_process', 'kill_process'])('shows terminal work for running %s only', (label) => {
    const activity = emptyLiveActivity(0);
    activity.steps.push({ id: 'tool', kind: 'tool', label, detail: '', at: 0, status: 'running' });
    expect(replyIconState(activity)).toBe('terminal');
    activity.steps[0].status = 'ok';
    expect(replyIconState(activity)).toBe('thinking');
  });

  it('keeps other tools, writing, and startup in the default face state', () => {
    expect(replyIconState(undefined)).toBe('idle');
    const activity = emptyLiveActivity(0);
    activity.tail = 'Writing a reply';
    expect(replyIconState(activity)).toBe('idle');
    activity.thinking = 'Considering the next step';
    expect(replyIconState(activity)).toBe('thinking');
    activity.steps.push({ id: 'read', kind: 'tool', label: 'read_file', detail: '', at: 0, status: 'running' });
    expect(replyIconState(activity)).toBe('idle');
  });

  it.each(['thinking', 'terminal'] as const)('renders the %s animation in the status row', (state) => {
    const markup = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={334} tps={0} out={3300} last={null} iconState={state} />);
    expect(markup).toContain(`data-mini-state="${state}"`);
    expect(markup).toContain(state === 'thinking' ? 'nekko-mini-thought-bubble' : 'nekko-mini-lines');
    expect(markup).not.toContain('pixel-head');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('334s');
  });
});
