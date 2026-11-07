import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './chat.js';
import {
  LIVE_STEP_CAP,
  LIVE_TAIL_CHARS,
  describeLiveActivity,
  reduceLiveActivity,
  shortLiveStatus,
  type LiveActivity,
} from './live-activity.js';

const S = 's1';
const text = (delta: string): AgentEvent => ({ type: 'text', sessionId: S, delta });
const reasoning = (delta: string): AgentEvent => ({ type: 'reasoning', sessionId: S, delta });
const toolCall = (id: string, name: string, input: Record<string, unknown>): AgentEvent =>
  ({ type: 'tool_call', sessionId: S, call: { id, name, input } });
const toolResult = (toolCallId: string, output: string, isError = false): AgentEvent =>
  ({ type: 'tool_result', sessionId: S, result: { toolCallId, output, ...(isError ? { isError } : {}) } });

/** Fold a run's worth of events the way the board does. */
function fold(events: AgentEvent[]): LiveActivity | undefined {
  let a: LiveActivity | undefined;
  events.forEach((e, i) => { a = reduceLiveActivity(a, e, 1_000 + i); });
  return a;
}

describe('reduceLiveActivity', () => {
  it('records a tool call as a running step and closes it on its result', () => {
    const a = fold([
      toolCall('t1', 'bash', { command: 'npm test -w apps/desktop' }),
      toolResult('t1', '42 passing\n1 failing'),
    ])!;
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]).toMatchObject({
      kind: 'tool',
      label: 'bash',
      detail: 'npm test -w apps/desktop',
      status: 'ok',
      result: '42 passing',
    });
  });

  it('marks a failed tool result as an error', () => {
    const a = fold([toolCall('t1', 'read_file', { path: 'nope.ts' }), toolResult('t1', 'ENOENT', true)])!;
    expect(a.steps[0].status).toBe('error');
  });

  it('closes the running tool when the provider hands back an id we never saw', () => {
    // Some providers echo a result id that does not match the call's. Dropping
    // the result would leave a step spinning for the rest of the run.
    const a = fold([toolCall('t1', 'grep', { pattern: 'TODO' }), toolResult('other', 'src/a.ts:1')])!;
    expect(a.steps[0].status).toBe('ok');
  });

  it('folds buffered reasoning into one step when the model moves on', () => {
    const a = fold([
      reasoning('The poller reads the queue twice. '),
      reasoning('So the fix is to take the lock before the read.'),
      toolCall('t1', 'edit_file', { file_path: 'src/poller.ts' }),
    ])!;
    expect(a.steps.map((s) => s.kind)).toEqual(['thinking', 'tool']);
    expect(a.steps[0].detail).toContain('take the lock');
    expect(a.thinking).toBe('');
  });

  it('drops a thought too short to say anything', () => {
    const a = fold([reasoning('Hmm. '), toolCall('t1', 'ls', { path: '.' })])!;
    expect(a.steps.map((s) => s.kind)).toEqual(['tool']);
  });

  it('keeps streaming narration as the tail until a tool interrupts it', () => {
    const a = fold([text('Looking at the failing spec first. ')])!;
    expect(a.tail).toBe('Looking at the failing spec first. ');
    expect(a.steps).toHaveLength(0);

    const b = fold([text('Looking at the failing spec first. '), toolCall('t1', 'read_file', { path: 'a.test.ts' })])!;
    expect(b.tail).toBe('');
    expect(b.steps.map((s) => s.kind)).toEqual(['note', 'tool']);
  });

  it('trims the tail so a long reply cannot grow without bound', () => {
    const a = fold([text('x'.repeat(LIVE_TAIL_CHARS * 3))])!;
    expect(a.tail).toHaveLength(LIVE_TAIL_CHARS);
  });

  it('keeps only the most recent steps', () => {
    const events = Array.from({ length: LIVE_STEP_CAP + 4 }, (_, i) => toolCall(`t${i}`, 'bash', { command: `run ${i}` }));
    const a = fold(events)!;
    expect(a.steps).toHaveLength(LIVE_STEP_CAP);
    expect(a.steps[a.steps.length - 1].detail).toBe(`run ${LIVE_STEP_CAP + 3}`);
  });

  it('adds up the turn’s token usage', () => {
    const a = fold([
      { type: 'usage', sessionId: S, inputTokens: 1_200, outputTokens: 80 },
      { type: 'usage', sessionId: S, inputTokens: 300, outputTokens: 40 },
    ])!;
    expect(a.inputTokens).toBe(1_500);
    expect(a.outputTokens).toBe(120);
  });

  it('leaves an approval to the card’s own buttons', () => {
    const a = fold([
      { type: 'tool_approval_required', sessionId: S, call: { id: 't1', name: 'bash', input: { command: 'rm -rf build' } }, reason: 'Destructive', severity: 'high' },
    ])!;
    expect(a.steps).toHaveLength(0);
  });

  it('clears when the run ends, so a finished card falls back to its transcript', () => {
    const a = reduceLiveActivity(fold([toolCall('t1', 'bash', { command: 'ls' })]), { type: 'done', sessionId: S, messageId: 'm1' }, 2_000);
    expect(a).toBeUndefined();
    const b = reduceLiveActivity(fold([toolCall('t1', 'bash', { command: 'ls' })]), { type: 'error', sessionId: S, message: 'boom' }, 2_000);
    expect(b).toBeUndefined();
  });
});

describe('describeLiveActivity', () => {
  it('says what the running tool is pointed at', () => {
    expect(describeLiveActivity(fold([toolCall('t1', 'bash', { command: 'npm run build' })]))).toBe('bash · npm run build');
  });

  it('prefers the thought in progress over the step behind it', () => {
    const a = fold([
      toolCall('t1', 'read_file', { path: 'a.ts' }),
      toolResult('t1', 'ok'),
      reasoning('So the parser needs to handle the empty case.'),
    ]);
    expect(describeLiveActivity(a)).toContain('empty case');
  });

  it('falls back to the narration, then to nothing at all', () => {
    expect(describeLiveActivity(fold([text('Rebuilding the index now.')]))).toBe('Rebuilding the index now.');
    expect(describeLiveActivity(undefined)).toBe('');
  });
});

describe('Claude Code compacting', () => {
  const compacting = (state: 'running' | 'done' | 'failed', error?: string): AgentEvent =>
    ({ type: 'claude_code_compacting', sessionId: S, state, ...(error ? { error } : {}) });

  it('says so while it lasts, over whatever ran before it', () => {
    const running = fold([toolCall('t1', 'bash', { command: 'npm test' }), toolResult('t1', 'ok'), compacting('running')]);
    expect(shortLiveStatus(running)).toBe('Compacting context');
    expect(running!.steps.at(-1)).toMatchObject({ kind: 'note', label: 'Compacting' });
    const after = fold([compacting('running'), compacting('done'), text('Carrying on.')]);
    expect(shortLiveStatus(after)).toBe('Writing reply');
  });

  it('records a failed compaction with its reason', () => {
    const a = fold([compacting('running'), compacting('failed', 'Not enough messages to compact.')]);
    expect(a!.compacting).toBe(false);
    expect(a!.steps.at(-1)).toMatchObject({ label: 'Compaction failed', detail: 'Not enough messages to compact.' });
  });
});
