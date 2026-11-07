import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyLiveActivity } from '@nekko-agent/shared';
import type { LiveRun } from '../../liveRuns.js';
import { TurnActivityStatus, turnActivityLabel } from './TurnActivityStatus.js';

const call = { id: 't', name: 'bash', input: {} };
const run = (overrides: Partial<LiveRun> = {}): LiveRun => ({
  sessionId: 's', blocks: [{ kind: 'activity', items: [{ kind: 'tool', call, startedAt: 1000, endedAt: 2100, failed: true }] }],
  tools: [call], startedAt: 1000, activity: emptyLiveActivity(1000), text: '', reasoning: '', reasoningStartedAt: 0,
  reasoningMs: 0, outputTokens: 0, inputTokens: 0, decodeMs: 0, stepMark: { blocks: [], text: '', reasoning: '' }, ...overrides,
});

describe('whole-turn visibility', () => {
  it('does not confuse a completed failed tool with a running tool', () => {
    expect(turnActivityLabel(run())).toBe('Tools finished · Waiting for the model');
    expect(turnActivityLabel(run({ blocks: [{ kind: 'activity', items: [{ kind: 'tool', call, startedAt: 1000 }] }] }))).toBe('Running 1 tool');
  });
  it('keeps the current state explicit after reasoning or narration', () => {
    expect(turnActivityLabel(run({ reasoningStartedAt: 2200 }))).toBe('Thinking');
    expect(turnActivityLabel(run({ generation: { chars: 20, startedAt: 2200, lastAt: 2300 }, blocks: [{ kind: 'text', text: 'Checking the result.' }] }))).toBe('Model responding');
  });
  it('prioritizes approval and retries over generic waiting', () => {
    const retry = run({ retrying: { attempt: 1, maxAttempts: 3, delayMs: 1000, reason: 'busy', at: 2200 } });
    expect(turnActivityLabel(retry)).toBe('Waiting to retry the model');
    expect(turnActivityLabel(retry, 't')).toBe('Waiting for your approval');
  });
  it('labels elapsed time as the whole turn, not the last 1.1 second tool', () => {
    vi.spyOn(Date, 'now').mockReturnValue(62000);
    try {
      const html = renderToStaticMarkup(<TurnActivityStatus run={run()} />);
      expect(html).toContain('Turn elapsed 1m 1s');
      expect(html).toContain('Tools finished');
      expect(html).toContain('Tool times measure individual calls');
    } finally { vi.restoreAllMocks(); }
  });
});
