import { describe, expect, it, vi } from 'vitest';
import { runAgent } from './loop.js';
import { ProviderHttpError } from '../providers/errors.js';
import type { Provider, ProviderChunk } from '../providers/types.js';
import type { ChatMessage } from '@nekko-agent/shared';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}_${content}`, role, content, createdAt: 0 };
}

/** A provider whose chat() streams a little and then throws, once per scripted failure, before it streams `rounds`. */
function flakyProvider(failures: unknown[], rounds: ProviderChunk[][]): Provider & { calls: number } {
  let i = 0;
  const p = {
    calls: 0,
    config: { id: 'p', kind: 'openai-compat' as const, label: 'x', baseUrl: 'x', enabled: true },
    listModels: async () => [],
    test: async () => ({ ok: true, message: '' }),
    async *chat() {
      p.calls++;
      const failure = failures.shift();
      if (failure) {
        yield { type: 'text', delta: 'partial ' } as ProviderChunk;
        throw failure;
      }
      const chunks = rounds[i++] ?? [{ type: 'done' }];
      for (const c of chunks) yield c;
    },
  };
  return p;
}

const noTool = async () => ({ toolCallId: 'x', output: '' });

/**
 * Collect a run's events with the retry backoff on a fake clock. The loop still
 * computes and reports its real delays (asserted below); only the waiting is
 * skipped. Real setImmediate hops let the in-memory provider settle between
 * timers without paying Windows' ~15 ms setTimeout granularity per retry.
 */
async function drain<T>(run: AsyncIterable<T>): Promise<T[]> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const events: T[] = [];
    let finished = false;
    const done = (async () => { for await (const e of run) events.push(e); })().finally(() => { finished = true; });
    while (!finished) {
      await new Promise((r) => setImmediate(r));
      vi.runOnlyPendingTimers();
    }
    await done;
    return events;
  } finally {
    vi.useRealTimers();
  }
}

describe('runAgent retries', () => {
  it('sends an overloaded call again, after a retry event, and keeps only the attempt that worked', async () => {
    const provider = flakyProvider(
      [new ProviderHttpError('anthropic 529: overloaded', 529, 1), new Error('terminated')],
      [[{ type: 'text', delta: 'Hello' }, { type: 'done' }]],
    );
    const history: ChatMessage[] = [msg('user', 'hi')];
    const events = [];
    events.push(...await drain(runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool: noTool })));
    expect(provider.calls).toBe(3);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ type: 'retry', attempt: 1, maxAttempts: 5, delayMs: 500, reason: 'anthropic 529: overloaded' });
    expect(retries[1]).toMatchObject({ type: 'retry', attempt: 2 });
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete' });
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello' });
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('ends the reply as interrupted when a failure is not transient', async () => {
    const provider = flakyProvider([new Error('anthropic 401: invalid x-api-key')], [[{ type: 'text', delta: 'never' }]]);
    const history: ChatMessage[] = [msg('user', 'hi')];
    const events = [];
    events.push(...await drain(runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool: noTool })));
    expect(provider.calls).toBe(1);
    expect(events.some((e) => e.type === 'retry')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'anthropic 401: invalid x-api-key' });
    expect(history.at(-1)).toMatchObject({ role: 'assistant', interrupted: true });
  });

  it('gives up after the last attempt and keeps what that attempt streamed', async () => {
    const failures = Array.from({ length: 6 }, () => new ProviderHttpError('anthropic 529: overloaded', 529, 1));
    const provider = flakyProvider(failures, []);
    const history: ChatMessage[] = [msg('user', 'hi')];
    const events = [];
    events.push(...await drain(runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool: noTool })));
    expect(provider.calls).toBe(5);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'anthropic 529: overloaded' });
  });

  it('does not wait out a backoff once the run is stopped', async () => {
    const abort = new AbortController();
    const provider = flakyProvider([new ProviderHttpError('anthropic 529: overloaded', 529, 60_000)], []);
    const history: ChatMessage[] = [msg('user', 'hi')];
    const events = [];
    const started = Date.now();
    for await (const e of runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool: noTool, signal: abort.signal })) {
      events.push(e);
      if (e.type === 'retry') abort.abort();
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Stopped' });
  });

  it('checkpoints the tool request before the tools run', async () => {
    let i = 0;
    const rounds: ProviderChunk[][] = [
      [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', input: { path: 'a' } } }],
      [{ type: 'text', delta: 'done' }],
    ];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        for (const c of rounds[i++] ?? [{ type: 'done' }]) yield c;
      },
    };
    const history: ChatMessage[] = [msg('user', 'go')];
    const seen: string[] = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async (c) => { seen.push(`tool:${history.at(-1)?.role}`); return { toolCallId: c.id, output: 'x' }; },
    })) seen.push(e.type);
    // `step` arrives with the assistant request already in the history, and
    // before the tool itself runs.
    expect(seen.slice(seen.indexOf('tool_call'))).toEqual(['tool_call', 'step', 'tool:assistant', 'tool_result', 'text', 'done']);
  });
});

describe('Wi-Fi recovery', () => {
  it('recovers beyond five failures without replaying completed tools', async () => {
    let calls = 0;
    const executeTool = vi.fn(async () => ({ toolCallId: 'c1', output: 'already done' }));
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [], test: async () => ({ ok: true, message: '' }),
      async *chat() {
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'read_file', input: { path: 'a' } } };
        } else if (calls <= 8) {
          yield { type: 'text', delta: 'discard this partial attempt' };
          throw new TypeError('fetch failed');
        } else {
          yield { type: 'text', delta: 'Recovered' };
        }
      },
    };
    const history = [msg('user', 'go')];
    const events = [];
    events.push(...await drain(runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool, retryBaseDelayMs: 0 })));
    expect(calls).toBe(9);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(7);
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete' });
    expect(history.at(-1)?.content).toBe('Recovered');
    expect(history.some((m) => m.content.includes('discard this'))).toBe(false);
  });

  it('stops network recovery immediately when cancelled', async () => {
    const abort = new AbortController();
    const provider = flakyProvider([new TypeError('fetch failed')], []);
    const events = [];
    for await (const e of runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history: [msg('user', 'go')], executeTool: noTool, signal: abort.signal })) {
      events.push(e);
      if (e.type === 'retry') abort.abort();
    }
    expect(provider.calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Stopped' });
  });

  it('bounds prolonged outages and preserves the last partial answer for manual resume', async () => {
    const provider = flakyProvider(Array.from({ length: 65 }, () => new TypeError('fetch failed')), []);
    const history = [msg('user', 'go')];
    const events = [];
    events.push(...await drain(runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool: noTool, retryBaseDelayMs: 0 })));
    expect(provider.calls).toBe(65);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'fetch failed' });
    expect(history.at(-1)).toMatchObject({ interrupted: true });
  });
});
