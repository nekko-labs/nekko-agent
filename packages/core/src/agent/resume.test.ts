import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@nekko-agent/shared';
import { INTERRUPTED_TOOL_OUTPUT, repairInterruptedHistory } from './resume.js';

const call = (id: string): ToolCall => ({ id, name: 'bash', input: { command: 'npm test' } });

function user(content: string): ChatMessage {
  return { id: `u_${content}`, role: 'user', content, createdAt: 1 };
}
function assistant(content: string, toolCalls?: ToolCall[]): ChatMessage {
  return { id: `a_${content}`, role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}), createdAt: 2 };
}
function toolResult(id: string, output: string): ChatMessage {
  return { id: `t_${id}`, role: 'tool', content: '', toolResult: { toolCallId: id, output }, createdAt: 3 };
}

describe('repairInterruptedHistory', () => {
  it('leaves a complete transcript untouched', () => {
    const history = [user('run the tests'), assistant('', [call('c1')]), toolResult('c1', 'ok'), assistant('passed')];
    const before = JSON.parse(JSON.stringify(history));
    expect(repairInterruptedHistory(history)).toBe(0);
    expect(history).toEqual(before);
  });

  it('answers a tool call that never ran, right after the request', () => {
    // What a run killed between asking for a tool and running it leaves behind.
    const history = [user('run the tests'), assistant('Running them now.', [call('c1')])];
    expect(repairInterruptedHistory(history)).toBe(1);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(history[2].toolResult).toEqual({
      toolCallId: 'c1',
      output: INTERRUPTED_TOOL_OUTPUT,
      isError: true,
    });
  });

  it('fills only the calls that are missing from a partly-run step', () => {
    const history = [user('go'), assistant('', [call('c1'), call('c2'), call('c3')]), toolResult('c2', 'done')];
    expect(repairInterruptedHistory(history)).toBe(2);
    const answered = history.filter((m) => m.role === 'tool').map((m) => m.toolResult!.toolCallId);
    expect(answered.sort()).toEqual(['c1', 'c2', 'c3']);
    // The existing result keeps its own output; only the gaps are stand-ins.
    expect(history.find((m) => m.toolResult?.toolCallId === 'c2')!.toolResult!.output).toBe('done');
  });

  it('repairs several interrupted steps across a long run', () => {
    const history = [
      user('go'),
      assistant('', [call('c1')]),
      toolResult('c1', 'ok'),
      assistant('', [call('c2')]), // this step never ran
      assistant('and this one asked too', [call('c3')]),
    ];
    expect(repairInterruptedHistory(history)).toBe(2);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
  });

  it('keeps the work already done rather than dropping the interrupted step', () => {
    // The point of repairing instead of truncating: 40 minutes of tool results
    // stay in the transcript so the model does not redo them.
    const history = [user('go'), assistant('', [call('c1')]), toolResult('c1', 'the expensive result'), assistant('', [call('c2')])];
    repairInterruptedHistory(history);
    expect(history.some((m) => m.toolResult?.output === 'the expensive result')).toBe(true);
  });

  it('moves delayed real results before follow-ups and fills only genuinely missing calls', () => {
    const result = toolResult('c1', 'Child completed, files saved');
    const history = [user('go'), assistant('', [call('c1'), call('c2')]), user('are you stuck?'), assistant('checking'), result];
    expect(repairInterruptedHistory(history)).toBe(1);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(history[3]).toBe(result);
    const before = JSON.stringify(history);
    expect(repairInterruptedHistory(history)).toBe(0);
    expect(JSON.stringify(history)).toBe(before);
  });

  it('handles an empty history', () => {
    const history: ChatMessage[] = [];
    expect(repairInterruptedHistory(history)).toBe(0);
    expect(history).toEqual([]);
  });
});
