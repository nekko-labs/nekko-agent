import { describe, it, expect, vi } from 'vitest';
import { asSeenByChatModel, runAgent, windowHistory } from './loop.js';
import { INTERRUPTED_NOTE, INTERRUPTED_TOOL_OUTPUT, RESUME_PROMPT } from './resume.js';
import type { ChatRequest, Provider, ProviderChunk } from '../providers/types.js';
import type { ChatMessage, ToolCall, ToolResult } from '@nekko-agent/shared';

/** A user/assistant message pair helper for building histories. */
function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}_${content}`, role, content, createdAt: 0 };
}

/** A scripted provider: each call to chat() yields the next pre-set chunk list. */
function scriptedProvider(rounds: ProviderChunk[][]): Provider {
  let i = 0;
  return {
    config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
    listModels: async () => [],
    test: async () => ({ ok: true, message: '' }),
    async *chat() {
      const chunks = rounds[i++] ?? [{ type: 'done' }];
      for (const c of chunks) yield c;
    },
  };
}

describe('runAgent', () => {
  it('repairs interrupted tool history for a normal follow-up without a resume nudge', async () => {
    const history: ChatMessage[] = [
      msg('user', 'delegate'),
      { ...msg('assistant', ''), toolCalls: [{ id: 'child', name: 'spawn_agent', input: {} }] },
      msg('user', 'continue directly'),
    ];
    const provider = scriptedProvider([[{ type: 'text', delta: 'continuing' }, { type: 'done' }]]);
    const chat = vi.spyOn(provider, 'chat');
    const executeTool = vi.fn();
    for await (const _ of runAgent({ sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool })) { /* drain */ }
    const sent = chat.mock.calls[0][0].messages;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(sent[2].toolResult).toMatchObject({ toolCallId: 'child', isError: true });
    expect(sent.at(-1)?.content).toBe('continue directly');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([
    { cacheReadTokens: 30 },
    { cacheWriteTokens: 20 },
    { cacheReadTokens: 0, cacheWriteTokens: 0 },
    { cacheReadTokens: 30, cacheWriteTokens: 20 },
    {},
  ])('forwards cache counters unchanged to accounting and events (%j)', async (counters) => {
    const onUsage = vi.fn();
    const usage: Extract<ProviderChunk, { type: 'usage' }> = {
      type: 'usage', inputTokens: 0, outputTokens: 0, outputMs: 10, ...counters,
    };
    const events = [];
    for await (const event of runAgent({
      sessionId: 's', provider: scriptedProvider([[usage, { type: 'done' }]]), model: 'm',
      system: 'sys', history: [msg('user', 'go')], onUsage,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) events.push(event);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      providerId: 'p', modelId: 'm', inputTokens: 0, outputTokens: 0,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    });
    expect(events.filter((event) => event.type === 'usage')).toEqual([{
      ...usage, sessionId: 's', cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    }]);
  });

  it('continues beyond the former 1000-step cap', async () => {
    const rounds: ProviderChunk[][] = Array.from({ length: 1001 }, (_, i) => [
      { type: 'tool_call', call: { id: `c${i}`, name: 'read_file', input: { path: `file-${i}` } } },
    ]);
    rounds.push([{ type: 'text', delta: 'finished' }]);
    const executeTool = vi.fn(async (c: ToolCall): Promise<ToolResult> => ({ toolCallId: c.id, output: c.id }));
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider: scriptedProvider(rounds), model: 'm', system: 'sys',
      history: [msg('user', 'go')], executeTool,
    })) events.push(e);
    expect(executeTool).toHaveBeenCalledTimes(1001);
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete', steps: 1001 });
  });

  it('streams text and completes when no tools are called', async () => {
    const provider = scriptedProvider([
      [{ type: 'text', delta: 'Hello' }, { type: 'text', delta: ' world' }, { type: 'done' }],
    ]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Hello world');
    expect(events.at(-1)?.type).toBe('done');
    // Assistant message appended to history.
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello world' });
  });

  it('executes tool calls and feeds results back, then finishes', async () => {
    const call: ToolCall = { id: 'c1', name: 'read_file', input: { path: 'a.ts' } };
    const provider = scriptedProvider([
      [{ type: 'tool_call', call }, { type: 'done' }], // round 1: call a tool
      [{ type: 'text', delta: 'done reading' }, { type: 'done' }], // round 2: final answer
    ]);
    const executeTool = vi.fn(async (c: ToolCall): Promise<ToolResult> => ({
      toolCallId: c.id, output: 'file contents',
    }));
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'read it', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool,
    })) {
      events.push(e);
    }
    expect(executeTool).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    // History contains: user, assistant(toolCall), tool(result), assistant(final).
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history.at(-1)?.content).toBe('done reading');
  });

  it('surfaces tool execution errors without throwing', async () => {
    const call: ToolCall = { id: 'c1', name: 'bash', input: { command: 'x' } };
    const provider = scriptedProvider([
      [{ type: 'tool_call', call }, { type: 'done' }],
      [{ type: 'text', delta: 'ok' }, { type: 'done' }],
    ]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 0 }];
    const results: ToolResult[] = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => {
        throw new Error('boom');
      },
    })) {
      if (e.type === 'tool_result') results.push(e.result);
    }
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain('boom');
  });

  it('forwards reasoning chunks as reasoning events', async () => {
    const provider = scriptedProvider([
      [{ type: 'reasoning', delta: 'thinking' }, { type: 'text', delta: 'ans' }, { type: 'done' }],
    ]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'q', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'reasoning' && (e as any).delta === 'thinking')).toBe(true);
  });

  it('retries once with a nudge when the model returns an empty response', async () => {
    // Round 1: the model stops cold (finish_reason "stop", nothing produced).
    // Round 2 (the nudged retry): a real answer.
    const provider = scriptedProvider([
      [{ type: 'done' }],
      [{ type: 'text', delta: 'recovered' }, { type: 'done' }],
    ]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    // The recovered text is what lands, and the nudge is not persisted.
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'recovered' });
    expect(history.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('surfaces a clear marker when the model stays empty after the retry', async () => {
    const provider = scriptedProvider([[{ type: 'done' }], [{ type: 'done' }]]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    expect(events.at(-1)?.type).toBe('done');
    expect(history.at(-1)?.role).toBe('assistant');
    expect(history.at(-1)?.content).toContain('empty response');
  });

  it('never stops a progressing reply on a step count', async () => {
    // A model that keeps reading different files for a long time, then answers.
    // There is no tool-step limit, so every round runs and no wrap-up pass (a
    // request with the tools withheld) is ever made.
    const seen: ChatRequest[] = [];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        seen.push(req);
        if (seen.length <= 300) {
          yield { type: 'tool_call', call: { id: `c${seen.length}`, name: 'read_file', input: { path: `f${seen.length}` } } } as ProviderChunk;
        } else {
          yield { type: 'text', delta: 'all done' } as ProviderChunk;
        }
        yield { type: 'done' } as ProviderChunk;
      },
    };
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'explore', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async (c) => ({ toolCallId: c.id, output: `contents of ${c.id}` }),
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete', steps: 300 });
    expect(seen).toHaveLength(301);
    expect(seen.every((r) => (r.tools?.length ?? 0) > 0)).toBe(true);
    expect(history.at(-1)?.content).toBe('all done');
    expect(history.some((m) => /limit/i.test(m.content))).toBe(false);
  });

  it('still notes why it stopped when the loop wrap-up pass produces nothing', async () => {
    // The same call with the same result, forever: the loop detector ends it.
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        if (req.tools?.length) yield { type: 'tool_call', call: { id: 'c', name: 'bash', input: {} } } as ProviderChunk;
        yield { type: 'done' } as ProviderChunk;
      },
    };
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async (c) => ({ toolCallId: c.id, output: 'ok' }),
    })) {
      events.push(e);
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'loop' });
    expect(history.at(-1)?.content).toContain('Stopped early');
    expect(history.at(-1)?.content).not.toMatch(/step.*limit/i);
  });

  it('cuts a reply off when the model collapses into a repeated phrase', async () => {
    // A model that degenerates and never stops (the observed LM Studio failure).
    // Without the guard this generator never returns and the reply hangs.
    let deltas = 0;
    let aborted = false;
    const provider: Provider = {
      config: { id: 'p', kind: 'lmstudio', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        req.signal?.addEventListener('abort', () => { aborted = true; });
        while (deltas < 100_000) {
          deltas++;
          yield { type: 'reasoning', delta: 'Let me start building this feature now.\n\n' } as ProviderChunk;
        }
        yield { type: 'done' } as ProviderChunk;
      },
    };
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'build it', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    // It ends, promptly, as a completed reply rather than an error.
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(deltas).toBeLessThan(200);
    // The stream was actually cancelled, not just abandoned mid-iterator.
    expect(aborted).toBe(true);
    // One assistant message, saying why it stopped, with the loop trimmed out.
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.content).toContain('repeating itself');
    expect(history.at(-1)?.reasoning!.length).toBeLessThan(6_000);
  });

  it('caps the reply and does not keep iterating after a runaway', async () => {
    // Round 1 loops. If the runaway didn't end the turn, round 2's tool call
    // would run and the transcript would grow past a single assistant message.
    const provider = scriptedProvider([
      Array.from({ length: 400 }, () => ({ type: 'text', delta: 'again and again and again. ' }) as ProviderChunk),
      [{ type: 'tool_call', call: { id: 'c', name: 'bash', input: {} } }, { type: 'done' }],
    ]);
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 0 }];
    const executeTool = vi.fn(async (c: ToolCall): Promise<ToolResult> => ({ toolCallId: c.id, output: '' }));
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, executeTool,
    })) { /* drain */ }
    expect(executeTool).not.toHaveBeenCalled();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('passes the output cap through to the provider', async () => {
    let seen: ChatRequest | null = null;
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        seen = req;
        yield { type: 'text', delta: 'ok' } as ProviderChunk;
        yield { type: 'done' } as ProviderChunk;
      },
    };
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys',
      history: [{ id: 'u', role: 'user', content: 'hi', createdAt: 0 }],
      maxOutputTokens: 2048,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) { /* drain */ }
    expect(seen!.maxOutputTokens).toBe(2048);
  });

  it('sends only the last N user-turn groups when maxHistoryTurns is set', async () => {
    let seen: ChatMessage[] = [];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        seen = req.messages;
        yield { type: 'text', delta: 'ok' } as ProviderChunk;
        yield { type: 'done' } as ProviderChunk;
      },
    };
    // Three prior turns (user→assistant) plus a fresh 4th user turn.
    const history: ChatMessage[] = [
      msg('user', 'u1'), msg('assistant', 'a1'),
      msg('user', 'u2'), msg('assistant', 'a2'),
      msg('user', 'u3'), msg('assistant', 'a3'),
      msg('user', 'u4'),
    ];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, maxHistoryTurns: 2,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) { /* drain */ }
    // Window keeps the last 2 user groups (u3,a3,u4); the new assistant is
    // appended to the FULL history, which still holds all four turns.
    expect(seen.map((m) => m.content)).toEqual(['u3', 'a3', 'u4']);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });
});

describe('runAgent, interrupted runs', () => {
  /** A provider whose stream breaks part-way through the reply. */
  function breakingProvider(before: ProviderChunk[], error = new Error('terminated')): Provider {
    return {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        for (const c of before) yield c;
        throw error;
      },
    };
  }

  it('keeps what the model wrote before the stream broke', async () => {
    // The reported bug: a timeout part-way through a long reply threw the reply
    // away and reported only a failure.
    const provider = breakingProvider([
      { type: 'text', delta: 'I found three problems. ' },
      { type: 'text', delta: 'The first is a race in the queue' },
    ]);
    const history: ChatMessage[] = [msg('user', 'review this')];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, retryBaseDelayMs: 0,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'terminated' });
    const kept = history.at(-1)!;
    expect(kept.role).toBe('assistant');
    expect(kept.interrupted).toBe(true);
    expect(kept.content).toContain('The first is a race in the queue');
    expect(kept.content).toContain(INTERRUPTED_NOTE);
  });

  it('keeps every step that completed before the break', async () => {
    const call: ToolCall = { id: 'c1', name: 'bash', input: { command: 'npm test' } };
    let round = 0;
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        if (round++ === 0) {
          yield { type: 'tool_call', call };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', delta: 'Reading the failure' };
        throw new Error('terminated');
      },
    };
    const history: ChatMessage[] = [msg('user', 'run the tests')];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, retryBaseDelayMs: 0,
      executeTool: async () => ({ toolCallId: 'c1', output: '3 tests failed' }),
    })) { /* drain */ }
    // user, assistant(tool call), tool(result), assistant(interrupted partial).
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history[2].toolResult?.output).toBe('3 tests failed');
    expect(history.at(-1)?.interrupted).toBe(true);
  });

  it('drops a tool call the model was still emitting when the stream broke', async () => {
    // It never ran and its arguments may be truncated, so it is not progress.
    const call: ToolCall = { id: 'c1', name: 'bash', input: { command: 'rm -r' } };
    const provider = breakingProvider([{ type: 'text', delta: 'Cleaning up' }, { type: 'tool_call', call }]);
    const history: ChatMessage[] = [msg('user', 'go')];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, retryBaseDelayMs: 0,
      executeTool: async () => ({ toolCallId: 'c1', output: 'ran' }),
    })) { /* drain */ }
    expect(history.at(-1)?.toolCalls).toBeUndefined();
  });

  it('adds nothing when the break came before the model said anything', async () => {
    const provider = breakingProvider([]);
    const history: ChatMessage[] = [msg('user', 'go')];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, retryBaseDelayMs: 0,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) { /* drain */ }
    expect(history.map((m) => m.role)).toEqual(['user']);
  });

  it('reports a stop the user asked for as stopped, not as a failure', async () => {
    const ctl = new AbortController();
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        yield { type: 'text', delta: 'Working on it' };
        ctl.abort();
        throw new Error('The operation was aborted');
      },
    };
    const history: ChatMessage[] = [msg('user', 'go')];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, signal: ctl.signal,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) {
      events.push(e);
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Stopped' });
    // Stopping keeps the partial reply too, so resuming has something to build on.
    expect(history.at(-1)?.content).toContain('Working on it');
  });
});

describe('runAgent, resuming', () => {
  it('continues the transcript instead of replaying the user turn', async () => {
    let sent: ChatMessage[] = [];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        sent = req.messages;
        yield { type: 'text', delta: 'and the second is a leak.' };
        yield { type: 'done' };
      },
    };
    const history: ChatMessage[] = [
      msg('user', 'review this'),
      { id: 'a1', role: 'assistant', content: 'I found three problems.', interrupted: true, createdAt: 2 },
    ];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, resume: true,
      executeTool: async () => ({ toolCallId: 'x', output: '' }),
    })) { /* drain */ }

    // The model is told to carry on, and the nudge is transient: it never lands
    // in the transcript the user reads.
    expect(sent.at(-1)?.content).toBe(RESUME_PROMPT);
    expect(history.some((m) => m.content === RESUME_PROMPT)).toBe(false);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(history.at(-1)?.content).toBe('and the second is a leak.');
  });

  it('answers a tool call that never ran, so the transcript can be sent again', async () => {
    const call: ToolCall = { id: 'c1', name: 'bash', input: { command: 'npm test' } };
    let sent: ChatMessage[] = [];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        sent = req.messages;
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done' };
      },
    };
    const history: ChatMessage[] = [msg('user', 'go'), { id: 'a1', role: 'assistant', content: '', toolCalls: [call], createdAt: 2 }];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, resume: true,
      executeTool: async () => ({ toolCallId: 'c1', output: 'ran' }),
    })) { /* drain */ }
    expect(sent.find((m) => m.toolResult?.toolCallId === 'c1')?.toolResult?.output).toBe(INTERRUPTED_TOOL_OUTPUT);
  });

  it('does not nudge when the transcript already ends on a tool result', async () => {
    const call: ToolCall = { id: 'c1', name: 'bash', input: {} };
    let sent: ChatMessage[] = [];
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(req: ChatRequest) {
        sent = req.messages;
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done' };
      },
    };
    const history: ChatMessage[] = [
      msg('user', 'go'),
      { id: 'a1', role: 'assistant', content: '', toolCalls: [call], createdAt: 2 },
      { id: 't1', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'ran' }, createdAt: 3 },
    ];
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history, resume: true,
      executeTool: async () => ({ toolCallId: 'c1', output: 'ran' }),
    })) { /* drain */ }
    expect(sent.some((m) => m.content === RESUME_PROMPT)).toBe(false);
  });
});

describe('windowHistory', () => {
  const h: ChatMessage[] = [
    msg('user', 'u1'), msg('assistant', 'a1'),
    msg('user', 'u2'), msg('assistant', 'a2'), msg('tool', 't2'), msg('assistant', 'a2b'),
    msg('user', 'u3'), msg('assistant', 'a3'),
  ];

  it('returns history unchanged with no limit (normal chats)', () => {
    expect(windowHistory(h, undefined)).toBe(h);
    expect(windowHistory(h, 0)).toBe(h);
  });

  it('returns history unchanged when there are fewer user turns than the limit', () => {
    expect(windowHistory(h, 5)).toBe(h);
    expect(windowHistory(h, 3)).toBe(h);
  });

  it('cuts on a user boundary, keeping complete turn groups', () => {
    // Last 2 user groups: u2 (with its assistant/tool/assistant) and u3.
    expect(windowHistory(h, 2).map((m) => m.content)).toEqual(['u2', 'a2', 't2', 'a2b', 'u3', 'a3']);
    // The window always begins on a user message (never a stranded tool result).
    expect(windowHistory(h, 2)[0].role).toBe('user');
    expect(windowHistory(h, 1).map((m) => m.content)).toEqual(['u3', 'a3']);
  });
});

describe('asSeenByChatModel', () => {
  it('turns a picture-only reply into a line a chat model can read, and leaves the rest alone', () => {
    const generated = { modelId: 'lmstudio/unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0', width: 1024, height: 768, steps: 4, cfgScale: 1, seed: 42, ms: 4000 };
    const img = { id: 'a', role: 'assistant' as const, content: '', images: ['data:image/png;base64,eA=='], generated, createdAt: 0 };
    expect(asSeenByChatModel(img).content).toBe('[Generated a 1024×768 image with flux-2-klein-9b-Q8_0, seed 42.]');
    const text = { id: 'b', role: 'assistant' as const, content: 'hi', createdAt: 0 };
    expect(asSeenByChatModel(text)).toBe(text);
  });
});

describe('decideRequestFromTool', () => {
  it('reshapes the flat question list into named questions, tolerating the usual slips', async () => {
    const { decideRequestFromTool } = await import('./tools.js');
    expect(decideRequestFromTool({
      state: 'charged twice',
      questions: [
        { id: 'team', type: 'choice', instructions: 'Which team?', options: ['billing', 'technical'] },
        { id: 'refund', type: 'noul', instructions: 'Asks for money back.', options: ['yes'] },
        { type: 'score', question: 'How urgent?', criteria: ['low', 'high'] },
      ],
    })).toEqual({
      state: 'charged twice',
      questions: {
        team: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 'technical'] },
        refund: { type: 'noul', instructions: 'Asks for money back.' },
        q3: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
      },
    });
    expect(decideRequestFromTool({ state: 's', questions: [{ id: 'team', type: 'choice', instructions: 'Who?', options: [{ label: 'billing', description: 'Payments' }, { label: 'tech' }] }] }).questions.team.criteria)
      .toEqual({ billing: 'Payments', tech: 'tech' });
  });
});
