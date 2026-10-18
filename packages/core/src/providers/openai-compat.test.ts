import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider, friendlyError, resetLearnedParams } from './openai-compat.js';
import type { ProviderConfig } from '@nekko-agent/shared';

const cfg: ProviderConfig = {
  id: 'p1',
  kind: 'openai-compat',
  label: 'Test',
  baseUrl: 'http://localhost:9999/v1',
  enabled: true,
};

/** Build a Response whose body streams the given SSE lines. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLearnedParams();
});

/** Read the JSON body of the spy's nth call. */
function sentBody(spy: ReturnType<typeof vi.spyOn>, call = 0): Record<string, unknown> {
  return JSON.parse((spy.mock.calls[call][1] as RequestInit).body as string);
}

describe('OpenAICompatProvider decode timing', () => {
  /** Stream chunks with a real pause between them, so the clock has something to measure. */
  function pacedResponse(steps: Array<{ line: string; delayMs?: number }>): Response {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const s of steps) {
          if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
          controller.enqueue(enc.encode(s.line));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('times generation only, leaving out the wait before the first token', async () => {
    // 60ms of prompt processing, then ~40ms of generating. Only the second half
    // is throughput; counting the first would report half the real rate.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      pacedResponse([
        { line: 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n', delayMs: 60 },
        { line: 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n', delayMs: 40 },
        { line: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' },
        { line: 'data: [DONE]\n\n' },
      ]),
    );

    let outputMs: number | undefined;
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'usage') outputMs = c.outputMs;
    }
    expect(outputMs).toBeGreaterThanOrEqual(30);
    expect(outputMs).toBeLessThan(60); // the pre-first-token wait is not in there
  });

  it('reports decode time for a response that only calls a tool', async () => {
    // Measure decode clock semantics, not when an eager stream is consumed.
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_015);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      pacedResponse([
        { line: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{}"}}]}}]}\n\n' },
        { line: 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n', delayMs: 15 },
        { line: 'data: [DONE]\n\n' },
      ]),
    );

    let outputMs: number | undefined;
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'usage') outputMs = c.outputMs;
    }
    expect(outputMs).toBe(15);
  });

  it('omits the timing when the model generated nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      pacedResponse([
        { line: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":0}}\n\n' },
        { line: 'data: [DONE]\n\n' },
      ]),
    );

    let saw = false;
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'usage') { saw = true; expect(c.outputMs).toBeUndefined(); }
    }
    expect(saw).toBe(true);
  });
});

describe('OpenAICompatProvider.chat', () => {
  it('streams text deltas and a usage event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const out: string[] = [];
    let usage: { i: number; o: number } | null = null;
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'text') out.push(c.delta);
      if (c.type === 'usage') usage = { i: c.inputTokens, o: c.outputTokens };
    }
    expect(out.join('')).toBe('Hello');
    expect(usage).toEqual({ i: 5, o: 2 });
  });

  it('accumulates streamed tool-call fragments into one call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const calls = [];
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'tool_call') calls.push(c.call);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].input).toEqual({ path: 'a.ts' });
  });

  it('lists models from the /models endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'llama3', context_length: 8192 }] }), { status: 200 }),
    );
    const models = await new OpenAICompatProvider(cfg).listModels();
    expect(models[0]).toMatchObject({ id: 'llama3', providerId: 'p1', contextLength: 8192 });
  });

  it('appends /v1 when the base URL has no path', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const bare: ProviderConfig = { ...cfg, baseUrl: 'http://10.5.0.2:1338' };
    await new OpenAICompatProvider(bare).listModels();
    expect(spy).toHaveBeenCalledWith('http://10.5.0.2:1338/v1/models', expect.anything());
  });

  it('leaves an explicit path untouched', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await new OpenAICompatProvider(cfg).listModels(); // cfg ends in /v1
    expect(spy).toHaveBeenCalledWith('http://localhost:9999/v1/models', expect.anything());
  });

  it('surfaces reasoning_content as reasoning chunks, separate from the answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" carefully."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"42"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    let reasoning = '';
    let answer = '';
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
      if (c.type === 'reasoning') reasoning += c.delta;
      if (c.type === 'text') answer += c.delta;
    }
    expect(reasoning).toBe('Let me think carefully.');
    expect(answer).toBe('42');
  });

  it('test() returns a friendly message when the server is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
    const r = await new OpenAICompatProvider({ ...cfg, baseUrl: 'http://10.5.0.2:1338' }).test();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can't reach the model server/i);
    expect(r.message).toContain('10.5.0.2:1338');
  });
});

describe('OpenAICompatProvider request shape', () => {
  it('sends reasoning_effort instead of temperature for a gpt-6 model on openai', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const openai: ProviderConfig = { ...cfg, id: 'oa', kind: 'openai' };
    for await (const _ of new OpenAICompatProvider(openai).chat({
      model: 'gpt-6-sol',
      effort: 'high',
      temperature: 1,
      maxOutputTokens: 100,
      messages: [],
    })) {
    }
    const body = sentBody(spy);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(100);
    expect(body.reasoning_effort).toBe('high');
  });

  it('sends reasoning.effort for an o-series model id through openrouter', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const or: ProviderConfig = { ...cfg, id: 'or', kind: 'openrouter' };
    for await (const _ of new OpenAICompatProvider(or).chat({ model: 'openai/o3', effort: 'low', messages: [] })) {
    }
    const body = sentBody(spy);
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('keeps temperature and enable_thinking for a reasoning-named model on a local server', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    for await (const _ of new OpenAICompatProvider(cfg).chat({ model: 'gpt-oss-120b', think: true, messages: [] })) {
    }
    const body = sentBody(spy);
    expect(body.temperature).toBe(0.7);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('drops a parameter the server blames, retries, and remembers for next time', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'", param: 'temperature' } }), {
        status: 400,
      }),
    );
    spy.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));

    const out: string[] = [];
    for await (const c of new OpenAICompatProvider(cfg).chat({ model: 'm', temperature: 0.5, messages: [] })) {
      if (c.type === 'text') out.push(c.delta);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBody(spy, 0).temperature).toBe(0.5);
    expect(sentBody(spy, 1).temperature).toBeUndefined();

    // A new provider for the same model opens on the learned shape.
    spy.mockClear();
    for await (const _ of new OpenAICompatProvider(cfg).chat({ model: 'm', temperature: 0.5, messages: [] })) {
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentBody(spy).temperature).toBeUndefined();
  });

  it('renames the parameter the server asks for instead', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            param: 'max_tokens',
          },
        }),
        { status: 400 },
      ),
    );
    spy.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    for await (const _ of new OpenAICompatProvider(cfg).chat({ model: 'm', maxOutputTokens: 10, messages: [] })) {
    }
    const retry = sentBody(spy, 1);
    expect(retry.max_tokens).toBeUndefined();
    expect(retry.max_completion_tokens).toBe(10);
  });

  it('drops a field named by a FastAPI detail.loc entry', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: [{ loc: ['body', 'stream_options'], msg: 'extra fields not permitted' }] }),
        { status: 422 },
      ),
    );
    spy.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    for await (const _ of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
    }
    expect(sentBody(spy, 1).stream_options).toBeUndefined();
  });

  it('does not retry a 400 that blames no sent parameter', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":{"message":"credit balance is too low"}}', { status: 400 }));
    await expect(
      (async () => {
        for await (const _ of new OpenAICompatProvider(cfg).chat({ model: 'm', messages: [] })) {
        }
      })(),
    ).rejects.toThrow('credit balance is too low');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('friendlyError', () => {
  it('maps connection failures to actionable guidance', () => {
    expect(friendlyError(new Error('ECONNREFUSED'), 'http://x:1/v1')).toMatch(/can't reach/i);
    expect(friendlyError(new Error('The user aborted a request.'), 'u')).toMatch(/cancelled/i);
    expect(friendlyError(new Error('weird thing'), 'u')).toBe('weird thing');
  });
});
