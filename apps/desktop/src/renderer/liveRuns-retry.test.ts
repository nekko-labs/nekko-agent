import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { shortLiveStatus } from '@nekko-agent/shared';
import { __resetLiveRuns, applyEvent, getLiveRun } from './liveRuns.js';

vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

const text = (delta: string): AgentEvent => ({ type: 'text', sessionId: 'a', delta });
const reasoning = (delta: string): AgentEvent => ({ type: 'reasoning', sessionId: 'a', delta });
const call = (id: string): AgentEvent => ({ type: 'tool_call', sessionId: 'a', call: { id, name: 'bash', input: {} } });
const result = (id: string): AgentEvent => ({ type: 'tool_result', sessionId: 'a', result: { toolCallId: id, output: 'ok' } });
const retry: AgentEvent = { type: 'retry', sessionId: 'a', attempt: 1, maxAttempts: 5, delayMs: 2000, reason: 'anthropic 529: overloaded' };

describe('liveRuns on retry', () => {
  beforeEach(() => __resetLiveRuns());

  it('rolls the reply back to the last step and remembers the retry until the next token', () => {
    applyEvent(text('Step one. '));
    applyEvent(call('c1'));
    applyEvent(result('c1'));
    applyEvent(reasoning('Hmm, '));
    applyEvent(text('half a sentence that will be regen'));
    expect(getLiveRun('a')!.text).toBe('Step one. half a sentence that will be regen');

    applyEvent(retry);
    const run = getLiveRun('a')!;
    expect(run.text).toBe('Step one. ');
    expect(run.reasoning).toBe('');
    expect(run.blocks.map((b) => b.kind)).toEqual(['text', 'activity']);
    expect(run.retrying).toMatchObject({ attempt: 1, maxAttempts: 5, delayMs: 2000 });
    // The rail says so too, instead of sitting on the discarded thought.
    expect(run.activity.thinking).toBe('');
    expect(run.activity.steps.at(-1)).toMatchObject({ kind: 'note', label: 'Retrying' });
    expect(run.activity.steps.at(-1)!.detail).toMatch(/1 of 5, in 2 s: anthropic 529/);

    applyEvent(text('Second try. '));
    expect(getLiveRun('a')!.retrying).toBeUndefined();
    expect(getLiveRun('a')!.text).toBe('Step one. Second try. ');
  });

  it('says a background reply paused for the person at the computer, not that it is retrying', () => {
    applyEvent(text('half a sentence'));
    applyEvent({ type: 'retry', sessionId: 'a', attempt: 1, maxAttempts: 5, delayMs: 0, reason: 'Paused while someone uses this computer', paused: true });
    const run = getLiveRun('a')!;
    expect(run.text).toBe('');
    expect(run.activity.steps.at(-1)).toMatchObject({ kind: 'note', label: 'Paused' });
    expect(run.activity.steps.at(-1)!.detail).toMatch(/carries on from here once it is free/);
    expect(shortLiveStatus(run.activity)).toBe('Paused');
  });

  it('starts the run on a retry too, and ignores step checkpoints', () => {
    applyEvent({ type: 'step', sessionId: 'a', messageId: 'm' });
    expect(getLiveRun('a')).toBeUndefined();
    applyEvent(retry);
    expect(getLiveRun('a')?.retrying?.attempt).toBe(1);
  });
});
