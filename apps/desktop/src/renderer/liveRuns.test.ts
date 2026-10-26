import { rememberedConnectivityNotices } from './components/ConnectivityNotices.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { LIVE_STREAM_MAX, __resetLiveRuns, applyEvent, clampLive, clearLiveRun, getLiveRun, runningSessionIds, takeFinishedRun } from './liveRuns.js';

// The registry repaints on an animation frame; the folding itself is synchronous
// and is what these tests are about, so the scheduler is stubbed out.
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

const text = (sessionId: string, delta: string): AgentEvent => ({ type: 'text', sessionId, delta });
const call = (sessionId: string, name: string): AgentEvent => ({
  type: 'tool_call',
  sessionId,
  call: { id: `c_${name}`, name, input: {} },
});

describe('liveRuns', () => {
  beforeEach(() => __resetLiveRuns());

  it('keeps progress messages between their tools while a turn is still running', () => {
    applyEvent(text('a', 'I will read the source.'));
    const first = getLiveRun('a')!.blocks[0];
    applyEvent(call('a', 'read_file'));
    applyEvent(text('a', 'I found the problem. '));
    applyEvent(text('a', 'Updating the composer.'));
    applyEvent(call('a', 'edit_file'));
    const blocks = getLiveRun('a')!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'activity', 'text', 'activity']);
    expect(blocks[0]).toBe(first);
    expect(blocks[2]).toEqual({ kind: 'text', text: 'I found the problem. Updating the composer.' });
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'reply' });
    expect(takeFinishedRun('a')!.blocks).toEqual(blocks);
  });

  it('times each tool call from its call to its result', () => {
    applyEvent(call('a', 'bash'), 1_000);
    applyEvent({ type: 'tool_result', sessionId: 'a', result: { toolCallId: 'c_bash', output: 'ok' } }, 3_500);
    const block = getLiveRun('a')!.blocks[0];
    expect(block.kind === 'activity' && block.items[0]).toMatchObject({ kind: 'tool', startedAt: 1_000, endedAt: 3_500 });
  });

  it('retains live connectivity notices without starting or resurrecting a run', () => {
    const notice = { id: 'outage1', kind: 'restored' as const, createdAt: 1000, content: 'Reachability restored; select Continue.' };
    applyEvent({ type: 'session_meta', sessionId: 'incognito', connectivityNotice: notice });
    applyEvent({ type: 'session_meta', sessionId: 'incognito', connectivityNotice: notice });
    expect(rememberedConnectivityNotices('incognito')).toEqual([notice]);
    expect(getLiveRun('incognito')).toBeUndefined();
    expect(runningSessionIds()).toEqual([]);
  });

  it('does not reopen a finished turn for a late session_meta', () => {
    // The auto-title lands after `done`; it used to resurrect an empty run that
    // nothing would ever end, leaving the chat on "Starting" indefinitely.
    applyEvent(text('a', 'reply'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm' });
    applyEvent({ type: 'session_meta', sessionId: 'a' });
    applyEvent({ type: 'question_resolved', sessionId: 'a', callId: 'c' });
    expect(getLiveRun('a')).toBeUndefined();
    expect(runningSessionIds()).toEqual([]);
  });

  it('accumulates a reply across events', () => {
    applyEvent(text('a', 'Hello'));
    applyEvent(text('a', ' world'));
    expect(getLiveRun('a')?.text).toBe('Hello world');
  });

  it('keeps a run alive with no component watching it', () => {
    // This is the whole point: the chat pane used to own the only subscription,
    // so switching workspaces unmounted it and the turn's output went nowhere.
    // Nothing here has ever rendered, and the run is still complete.
    applyEvent(text('a', 'part one'));
    applyEvent(call('a', 'read_file'));
    applyEvent(text('a', ' part two'));

    const run = getLiveRun('a');
    expect(run?.text).toBe('part one part two');
    expect(run?.tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('keeps several sessions running at once without mixing them', () => {
    applyEvent(text('a', 'alpha'));
    applyEvent(text('b', 'beta'));
    applyEvent(text('a', '!'));

    expect(getLiveRun('a')?.text).toBe('alpha!');
    expect(getLiveRun('b')?.text).toBe('beta');
    expect(runningSessionIds().sort()).toEqual(['a', 'b']);
  });

  it('drops the run when the turn finishes, so the stored transcript takes over', () => {
    applyEvent(text('a', 'done soon'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('drops the run on an error too', () => {
    applyEvent(text('a', 'partial'));
    applyEvent({ type: 'error', sessionId: 'a', message: 'boom' });
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('ends one session without disturbing another still running', () => {
    applyEvent(text('a', 'alpha'));
    applyEvent(text('b', 'beta'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });

    expect(getLiveRun('a')).toBeUndefined();
    expect(getLiveRun('b')?.text).toBe('beta');
  });

  it('sums usage across a turn\'s steps rather than replacing it', () => {
    // A multi-step turn reports usage per step; the rate is over the whole turn.
    applyEvent({ type: 'usage', sessionId: 'a', inputTokens: 100, outputTokens: 10, outputMs: 500 });
    applyEvent({ type: 'usage', sessionId: 'a', inputTokens: 200, outputTokens: 30, outputMs: 1_000 });

    const run = getLiveRun('a');
    expect(run?.outputTokens).toBe(40);
    expect(run?.inputTokens).toBe(300);
    expect(run?.decodeMs).toBe(1_500);
  });

  it('measures how long the model spent reasoning, closed out by its answer', () => {
    applyEvent({ type: 'reasoning', sessionId: 'a', delta: 'hmm' }, 1_000);
    applyEvent(text('a', 'answer'), 3_500);
    expect(getLiveRun('a')?.reasoningMs).toBe(2_500);
    // Closed out, so the pane does not keep showing a thinking indicator.
    expect(getLiveRun('a')?.reasoningStartedAt).toBe(0);
  });

  it('folds the step rail alongside the raw text', () => {
    applyEvent(call('a', 'grep'));
    const steps = getLiveRun('a')?.activity.steps ?? [];
    expect(steps.at(-1)).toMatchObject({ kind: 'tool', label: 'grep', status: 'running' });
  });

  it('lets a pane retire a run it has folded into the transcript', () => {
    applyEvent(text('a', 'x'));
    clearLiveRun('a');
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('ignores a clear for a session that is not running', () => {
    expect(() => clearLiveRun('nobody')).not.toThrow();
  });

  it('hands the finished run over once, so the pane can hold it until the transcript lands', () => {
    applyEvent(text('a', 'the whole answer'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });
    expect(getLiveRun('a')).toBeUndefined();
    expect(runningSessionIds()).toEqual([]);
    expect(takeFinishedRun('a')?.text).toBe('the whole answer');
    expect(takeFinishedRun('a')).toBeUndefined();
  });

  it('forgets a finished run once the next turn starts', () => {
    applyEvent(text('a', 'first'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });
    applyEvent(text('a', 'second'));
    expect(takeFinishedRun('a')).toBeUndefined();
    expect(getLiveRun('a')?.text).toBe('second');
  });

  it('never holds more than the live cap, keeping the tail that is still being written', () => {
    const para = 'x'.repeat(99) + '\n\n';
    for (let i = 0; i < 600; i++) applyEvent(text('a', para));
    const t = getLiveRun('a')!.text;
    expect(t.length).toBeLessThanOrEqual(LIVE_STREAM_MAX + 2);
    expect(t.startsWith('…\n')).toBe(true);
    expect(t.endsWith(para)).toBe(true);
  });

  it('cuts back at a paragraph break, so the kept text stops shifting for a while', () => {
    const over = 'a'.repeat(LIVE_STREAM_MAX - 10) + '\n\nlast paragraph ' + 'b'.repeat(40);
    const clamped = clampLive(over);
    expect(clamped.length).toBeLessThan(LIVE_STREAM_MAX);
    expect(clampLive('short')).toBe('short');
    // Appending a little more does not move the cut again.
    expect(clampLive(clamped + 'more')).toBe(clamped + 'more');
  });
});
