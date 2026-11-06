import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from './chat.js';
import { accumulateDecodeMs, decodeRate, formatRate, hasResumableProgress } from './chat.js';

describe('decodeRate', () => {
  it('does not report buffered output as thousands of tokens per second', () => {
    expect(decodeRate(106, 4)).toBe(0);
    expect(decodeRate(106, 1)).toBe(0);
    expect(decodeRate(106, NaN)).toBe(0);
  });

  it('does not pair untimed tokens with another step timing', () => {
    const measured = accumulateDecodeMs(0, 100, 2000);
    expect(decodeRate(100, measured)).toBe(50);
    const incomplete = accumulateDecodeMs(measured, 106, 4);
    expect(decodeRate(206, incomplete)).toBe(0);
    expect(accumulateDecodeMs(incomplete, 100, 2000)).toBe(-1);
    expect(accumulateDecodeMs(measured, 106)).toBe(-1);
    expect(accumulateDecodeMs(measured, 0)).toBe(measured);
  });
  it('divides tokens by the time spent generating them', () => {
    expect(decodeRate(500, 10_000)).toBe(50);
  });

  it('ignores the wait around generation', () => {
    // The regression this fixes: a turn that generated for 10s and then spent 40s
    // running a tool used to be reported at 10 tok/s instead of 50.
    const generated = decodeRate(500, 10_000);
    const wholeTurn = 500 / 50; // what dividing by the 50s wall clock would give
    expect(generated).toBe(50);
    expect(wholeTurn).toBe(10);
  });

  it('sums across a reply that took several model calls', () => {
    // Three steps of 100 tokens, 2s of decode each; the tool time between them
    // never enters the arithmetic.
    expect(decodeRate(300, 6_000)).toBe(50);
  });

  it('returns 0 when there is nothing to divide', () => {
    expect(decodeRate(0, 1_000)).toBe(0);
    expect(decodeRate(100, 0)).toBe(0);
    expect(decodeRate(-1, 1_000)).toBe(0);
  });
});

describe('formatRate', () => {
  it('keeps a decimal for the single-digit rates a local model produces', () => {
    expect(formatRate(8.64)).toBe('8.6');
    expect(formatRate(0.42)).toBe('0.4');
  });

  it('rounds once the rate is fast enough for the decimal to be noise', () => {
    expect(formatRate(10)).toBe('10');
    expect(formatRate(147.3)).toBe('147');
  });
});

const call = (id: string): ToolCall => ({ id, name: 'bash', input: { command: 'npm test' } });
const user = (content: string): ChatMessage => ({ id: `u_${content}`, role: 'user', content, createdAt: 1 });
const assistant = (content: string, toolCalls?: ToolCall[]): ChatMessage =>
  ({ id: `a_${content}`, role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}), createdAt: 2 });
const toolResult = (id: string, output: string): ChatMessage =>
  ({ id: `t_${id}`, role: 'tool', content: '', toolResult: { toolCallId: id, output }, createdAt: 3 });

describe('hasResumableProgress', () => {
  it('is true once a tool has run', () => {
    expect(hasResumableProgress([user('go'), assistant('', [call('c1')]), toolResult('c1', 'ok')])).toBe(true);
  });

  it('is true when a cut-off reply left text behind', () => {
    expect(hasResumableProgress([user('go'), assistant('I found three problems, the first')])).toBe(true);
  });

  it('is true when only reasoning survived', () => {
    const thinking: ChatMessage = { id: 'a', role: 'assistant', content: '', reasoning: 'weighing options', createdAt: 2 };
    expect(hasResumableProgress([user('go'), thinking])).toBe(true);
  });

  it('is false when the run broke before the model said anything', () => {
    expect(hasResumableProgress([user('go')])).toBe(false);
    expect(hasResumableProgress([user('first'), assistant('answered'), user('second')])).toBe(false);
  });

  it('is false for an empty transcript', () => {
    expect(hasResumableProgress([])).toBe(false);
  });
});
