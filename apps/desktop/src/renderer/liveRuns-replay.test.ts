import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { __resetLiveRuns, applyEvent, applyReplay, getLiveRun, runningSessionIds, takeFinishedRun } from './liveRuns.js';

vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

const text = (sessionId: string, delta: string): AgentEvent => ({ type: 'text', sessionId, delta });

describe('a chat shown mid-turn (agent:replay, #551)', () => {
  beforeEach(() => __resetLiveRuns());

  it('rebuilds the run from the replay instead of the summary it had', () => {
    // A window not showing s1 hears only the turn's first event.
    applyEvent(text('s1', 'Hel'), 1_000);
    expect(getLiveRun('s1')!.text).toBe('Hel');
    applyReplay({
      sessionId: 's1',
      events: [text('s1', 'Hello there. '), { type: 'tool_call', sessionId: 's1', call: { id: 'c1', name: 'read_file', input: {} } }],
      at: [1_000, 1_500],
      truncated: false,
    });
    const run = getLiveRun('s1')!;
    expect(run.text).toBe('Hello there. ');
    expect(run.tools.map((t) => t.id)).toEqual(['c1']);
    expect(run.blocks.map((b) => b.kind)).toEqual(['text', 'activity']);
    expect(run.startedAt).toBe(1_000);
    // Live events continue it, once each.
    applyEvent(text('s1', 'Done.'));
    expect(getLiveRun('s1')!.text).toBe('Hello there. Done.');
  });

  it('opens a run for a chat this window had not seen running', () => {
    applyReplay({ sessionId: 's2', events: [text('s2', 'abc')], at: [5], truncated: true });
    expect(runningSessionIds()).toEqual(['s2']);
    expect(getLiveRun('s2')!.startedAt).toBe(5);
  });

  it('ignores an empty replay and keeps a finished turn finished', () => {
    applyEvent(text('s3', 'x'));
    applyEvent({ type: 'done', sessionId: 's3', messageId: 'm' });
    applyReplay({ sessionId: 's3', events: [], at: [], truncated: false });
    expect(getLiveRun('s3')).toBeUndefined();
    expect(takeFinishedRun('s3')!.text).toBe('x');
  });
});
