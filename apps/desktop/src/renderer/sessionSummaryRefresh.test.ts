import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { startSessionSummaryRefresh } from './sessionSummaryRefresh.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('refreshes watch summaries on metadata and terminal events, not streamed tokens', async () => {
  vi.useFakeTimers();
  let listener!: (event: AgentEvent) => void;
  const off = vi.fn();
  vi.stubGlobal('window', { nekko: { onAgentEvent: (cb: typeof listener) => { listener = cb; return off; } } });
  const refresh = vi.fn(async () => {});
  const stop = startSessionSummaryRefresh(refresh);
  listener({ type: 'text', sessionId: 's', delta: 'hi' });
  await vi.runAllTimersAsync();
  expect(refresh).not.toHaveBeenCalled();
  for (const type of ['session_meta', 'done', 'error'] as const) listener({ type, sessionId: 's' } as AgentEvent);
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledOnce();
  listener({ type: 'session_meta', sessionId: 's' });
  stop();
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledOnce();
  expect(off).toHaveBeenCalledOnce();
});

it('serializes delayed refreshes and follows an in-flight watch invalidation once', async () => {
  vi.useFakeTimers();
  let listener!: (event: AgentEvent) => void;
  vi.stubGlobal('window', { nekko: { onAgentEvent: (cb: typeof listener) => { listener = cb; return () => {}; } } });
  let finish!: () => void;
  const first = new Promise<void>(resolve => { finish = resolve; });
  const refresh = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
  const stop = startSessionSummaryRefresh(refresh);
  listener({ type: 'session_meta', sessionId: 's' });
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledOnce();
  listener({ type: 'session_meta', sessionId: 's' });
  listener({ type: 'done', sessionId: 's', messageId: 'reply' });
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledOnce();
  finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
});

it('does not retry a failed refresh without a new invalidation', async () => {
  vi.useFakeTimers();
  let listener!: (event: AgentEvent) => void;
  vi.stubGlobal('window', { nekko: { onAgentEvent: (cb: typeof listener) => { listener = cb; return () => {}; } } });
  const refresh = vi.fn().mockRejectedValue(new Error('offline'));
  const stop = startSessionSummaryRefresh(refresh);
  listener({ type: 'session_meta', sessionId: 's' });
  await vi.runAllTimersAsync();
  expect(refresh).toHaveBeenCalledOnce();
  stop();
});
