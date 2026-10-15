import { describe, expect, it } from 'vitest';
import { describeInterruption, shouldShowPersistedInterruption, suggestedReplyClassName } from './interruption.js';

describe('describeInterruption', () => {
  it('treats an intentional stop as a pause, not an error', () => {
    expect(describeInterruption('Stopped', true)).toMatchObject({
      paused: true,
      title: 'Reply paused',
      reason: 'You stopped this reply.',
    });
    expect(describeInterruption('Stopped', true).detail).toContain('Retry picks up from here');
  });

  it('names a context overflow as out of context, in the paused colour, and says it carries on', () => {
    const result = describeInterruption("openai 400: This model's maximum context length is 8192 tokens", true);
    expect(result).toMatchObject({ paused: true, title: 'Out of context' });
    expect(result.reason).toContain('compacts it and carries on');
    expect(describeInterruption('429 rate limit: too many tokens per min', true).title).toBe('Reply failed');
  });

  it('explains terminated without inventing a cause or calling it a pause', () => {
    const result = describeInterruption('terminated', true);
    expect(result.paused).toBe(false);
    expect(result.title).toBe('Reply failed');
    expect(result.detail).toContain('response stream ended unexpectedly');
    expect(result.detail).toContain('did not report a specific cause');
  });

  it('preserves specific provider errors', () => {
    expect(describeInterruption('Rate limit exceeded', true).reason).toBe('Rate limit exceeded');
  });

  it('only promises continuation when progress can be resumed', () => {
    const result = describeInterruption('Stopped', false);
    expect(result.detail).toContain('No resumable progress was saved');
    expect(result.detail).not.toContain('Retry picks up');
  });

  it('gives suggestions a theme tint and keyboard focus treatment', () => {
    expect(suggestedReplyClassName).toContain('bg-accent/10');
    expect(suggestedReplyClassName).toContain('focus-visible:outline-accent');
  });
});

describe('persisted interruption after completion', () => {
  const stale = [{ id: 'tool-call', role: 'assistant' as const, content: '', toolCalls: [{ id: 'call', name: 'bash', input: {} }], createdAt: 1 }];
  it('ignores stale tool calls while the finished reply awaits its transcript', () => {
    expect(shouldShowPersistedInterruption(stale, true, false)).toBe(false);
    expect(shouldShowPersistedInterruption(stale, false, true)).toBe(false);
    const finished = [...stale, { id: 'result', role: 'tool' as const, content: 'ok', toolResult: { toolCallId: 'call', output: 'ok' }, createdAt: 2 }, { id: 'final', role: 'assistant' as const, content: 'Done.', createdAt: 2 }];
    expect(shouldShowPersistedInterruption(finished, false, false)).toBe(false);
  });
  it('still detects a genuinely interrupted persisted reply', () => {
    expect(shouldShowPersistedInterruption(stale, false, false)).toBe(true);
    expect(shouldShowPersistedInterruption([{ id: 'cut', role: 'assistant', content: 'Partial', interrupted: true, createdAt: 1 }], false, false)).toBe(true);
  });
});

describe('question waits', () => {
  it('does not mistake a pending ask_user for interruption', () => {
    const history = [{ id: 'ask', role: 'assistant' as const, content: '', toolCalls: [{ id: 'q', name: 'ask_user', input: {} }], createdAt: 1 }];
    expect(shouldShowPersistedInterruption(history, false, false, true)).toBe(false);
    expect(shouldShowPersistedInterruption(history, false, false, false)).toBe(true);
  });
});
