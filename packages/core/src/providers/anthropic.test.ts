import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  AnthropicProvider,
  learnOutputLimit,
  outputCapFor,
  outputLimitError,
  firstSamplingShape,
  isSamplingParamError,
  nextSamplingShape,
  rejectsSampling,
  resetLearnedSampling,
} from './anthropic.js';
import type { EffortLevel, ProviderConfig } from '@nekko-agent/shared';

const apiKeyCfg: ProviderConfig = {
  id: 'p1',
  kind: 'anthropic',
  label: 'Claude',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  enabled: true,
};

const subCfg: ProviderConfig = {
  ...apiKeyCfg,
  apiKey: 'oauth-access-token',
  auth: 'subscription',
  tokenKey: 'claude:acct',
};

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

const DONE_STREAM = ['data: {"type":"message_stop"}\n\n'];

async function runChat(
  cfg: ProviderConfig,
  system?: string,
  extra: { model?: string; effort?: EffortLevel } = {},
) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(DONE_STREAM));
  const chat = new AnthropicProvider(cfg).chat({
    model: extra.model ?? 'claude-sonnet-4-6',
    messages: [],
    system,
    temperature: 0.7,
    effort: extra.effort,
  });
  for await (const _ of chat) {
    /* drain */
  }
  // The last call, not the first: a test that runs two chats re-spies on the
  // same mock, so the calls accumulate.
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

afterEach(() => vi.restoreAllMocks());

describe('AnthropicProvider subscription auth', () => {
  it('sends x-api-key in API-key mode, unchanged', async () => {
    const { headers, body } = await runChat(apiKeyCfg, 'be terse');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(body.system).toEqual([{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }]);
  });

  it('sends a Bearer token plus the oauth beta header in subscription mode', async () => {
    const { headers } = await runChat(subCfg, 'be terse');
    expect(headers.Authorization).toBe('Bearer oauth-access-token');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('prepends the Claude Code identity block ahead of the real system prompt', async () => {
    const { body } = await runChat(subCfg, 'You are a coding agent.');
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].text).toContain('Claude Code');
    expect(body.system[1].text).toBe('You are a coding agent.');
  });

  it('still sends the required prefix when the request has no system prompt', async () => {
    const { body } = await runChat(subCfg);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toContain('Claude Code');
  });

  it('sends an effort level instead of a temperature on models that dropped sampling', async () => {
    const { body } = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: 'normal' });
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('sends the chosen rung as-is, and the model default for normal', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { body } = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: level });
      expect(body.output_config).toEqual({ effort: level });
    }
    const opus5 = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: 'normal' });
    expect(opus5.body.output_config).toEqual({ effort: 'high' });
    // Opus 5.5 defaults one rung lower, and "normal" follows the model.
    const opus55 = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5-5', effort: 'normal' });
    expect(opus55.body.output_config).toEqual({ effort: 'medium' });
  });

  it('still sends a temperature to models that accept one', async () => {
    const { body } = await runChat(apiKeyCfg, undefined, { model: 'claude-sonnet-4-6', effort: 'normal' });
    expect(body.temperature).toBe(0.7);
    expect(body.output_config).toBeUndefined();
  });

  it('test() reports subscription sign-in state', async () => {
    expect(await new AnthropicProvider(subCfg).test()).toEqual({
      ok: true,
      message: 'Signed in with a Claude subscription',
    });
    const signedOut = await new AnthropicProvider({ ...subCfg, apiKey: undefined }).test();
    expect(signedOut.ok).toBe(false);
    expect(signedOut.message).toMatch(/sign in/i);
  });
});

/** A `GET /v1/models` answer with these rows. */
function modelsResponse(data: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ data, has_more: false }), { status });
}

describe('the live Claude catalog', () => {
  const live = [
    { type: 'model', id: 'claude-opus-6', display_name: 'Claude Opus 6' },
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    { type: 'model', id: 'claude-labs-x', display_name: 'Claude Labs X', max_input_tokens: 500_000 },
    // The table says 200k for every Haiku; the API knows better.
    { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1_000_000 },
    { type: 'model', id: 'claude-no-name' },
    { type: 'model', display_name: 'no id' },
  ];

  it('serves the models the API lists', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse(live));
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-6', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-labs-x', 'claude-no-name']);
    expect(models.every((m) => m.providerId === 'p1')).toBe(true);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('names each model by its display name, else its id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse(live));
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    expect(models.map((m) => m.name)).toEqual(['Claude Opus 6', 'Claude Opus 5.5', 'Claude Haiku 5.5', 'Claude Labs X', 'claude-no-name']);
  });

  it('takes the context window from the API, then the model table, then 200k', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse(live));
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    expect(models.map((m) => m.contextLength)).toEqual([1_000_000, 1_000_000, 1_000_000, 500_000, 200_000]);
  });

  it('groups by family, Opus to Haiku, newest first within each, unknown ids last', async () => {
    // The API's own order: newest release first, whatever the family.
    const newestFirst = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-labs-x', 'claude-fable-5-1', 'claude-opus-5', 'claude-mythos-1', 'claude-haiku-4-5-20251001'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse(newestFirst.map((id) => ({ type: 'model', id }))));
    const ids = (await new AnthropicProvider(apiKeyCfg).listModels()).map((m) => m.id);
    expect(ids).toEqual([
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-fable-5-1',
      'claude-mythos-1',
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
      'claude-labs-x',
    ]);
  });

  it('asks with the subscription token in subscription mode', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse(live));
    const models = await new AnthropicProvider(subCfg).listModels();
    expect(models[0].id).toBe('claude-opus-6');
    const headers = (spy.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer oauth-access-token');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('gives up after 5 seconds and serves the shipped list', async () => {
    vi.useFakeTimers();
    try {
      // A server that accepts the connection and never answers.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const pending = new AnthropicProvider(apiKeyCfg).listModels();
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).map((m) => m.id)).toContain('claude-opus-5-5');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the shipped list when offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const ids = (await new AnthropicProvider(apiKeyCfg).listModels()).map((m) => m.id);
    expect(ids).toContain('claude-opus-5-5');
  });

  it('falls back to the shipped list on an error status, an empty list or a malformed body', async () => {
    for (const res of [
      modelsResponse([], 401),
      modelsResponse([]),
      new Response('not json', { status: 200 }),
      new Response('{"data":"nope"}', { status: 200 }),
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
      const ids = (await new AnthropicProvider(apiKeyCfg).listModels()).map((m) => m.id);
      expect(ids).toContain('claude-opus-5-5');
      vi.restoreAllMocks();
    }
  });

  it('serves the shipped list without a network call when there is no key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const models = await new AnthropicProvider({ ...apiKeyCfg, apiKey: undefined }).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the shipped Claude catalog', () => {
  // The fallback list, reached here with the network down.
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  });

  it('lists Opus 5.5, newest Opus first', async () => {
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('claude-opus-5-5');
    // Newest first within a family, so the default pick is the current model
    // rather than whichever one happened to be added to the array first.
    expect(ids.indexOf('claude-opus-5-5')).toBeLessThan(ids.indexOf('claude-opus-5'));
  });

  it('gives Opus 5.5 a name and a context window', async () => {
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    expect(models.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5',
      contextLength: 1_000_000,
    });
  });

  it('lists Haiku 5.5 at 1M, above Haiku 4.5 at 200k', async () => {
    const models = await new AnthropicProvider(apiKeyCfg).listModels();
    const ids = models.map((m) => m.id);
    expect(ids.indexOf('claude-haiku-5-5')).toBeGreaterThan(-1);
    expect(ids.indexOf('claude-haiku-5-5')).toBeLessThan(ids.indexOf('claude-haiku-4-5-20251001'));
    expect(models.find((m) => m.id === 'claude-haiku-5-5')).toMatchObject({ name: 'Claude Haiku 5.5', contextLength: 1_000_000 });
    expect(models.find((m) => m.id === 'claude-haiku-4-5-20251001')?.contextLength).toBe(200_000);
  });
});

describe('rejectsSampling', () => {
  it('rejects sampling from the 4.7 generation onwards', () => {
    for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-6']) {
      expect(rejectsSampling(m), m).toBe(true);
    }
  });

  it('rejects sampling on every Fable and Mythos model', () => {
    expect(rejectsSampling('claude-fable-5-1')).toBe(true);
    expect(rejectsSampling('claude-mythos-5-1')).toBe(true);
  });

  it('keeps sampling on 4.6 and older, including dated ids', () => {
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022']) {
      expect(rejectsSampling(m), m).toBe(false);
    }
  });

  it('reads a Claude name through a proxy prefix', () => {
    // This used to fall through to the sampling path, on the reasoning that a
    // proxy might serve something else under that name. In practice it serves
    // exactly what it says, and a wrong guess cost the user a 400. Reading the
    // name is the better bet now that a wrong guess is recovered rather than
    // fatal.
    expect(rejectsSampling('my-proxy/claude-opus-5')).toBe(true);
    expect(rejectsSampling('my-proxy/claude-sonnet-4-6')).toBe(false);
  });

  it('leaves a name it cannot parse at all on the sampling path', () => {
    expect(rejectsSampling('some-finetune-v2')).toBe(false);
    expect(rejectsSampling('')).toBe(false);
  });
});

describe('sampling parameter recovery', () => {
  beforeEach(() => resetLearnedSampling());

  /** A 400 in Anthropic's error shape. */
  const samplingError = (message: string) =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
      status: 400,
    });

  const drain = async (it: AsyncIterable<unknown>) => {
    const out = [];
    for await (const c of it) out.push(c);
    return out;
  };

  const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

  it('retries without the temperature when the model rejects it, and remembers', async () => {
    // The exact failure a user hit: a model our version rule read as still
    // sampling, which the API says is past that.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`temperature` is deprecated for this model.'))
      .mockResolvedValue(sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-4-6', messages: [], system: '' } as never));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0])).toHaveProperty('temperature');
    const retry = bodyOf(fetchMock.mock.calls[1]);
    expect(retry.temperature).toBeUndefined();
    expect(retry.output_config).toEqual({ effort: 'high' });

    // The next turn is right the first time: the API's answer outranks the guess.
    expect(rejectsSampling('claude-opus-4-6')).toBe(true);
  });

  it('retries the other way when a model rejects the effort knob', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`output_config` is not supported for this model.'))
      .mockResolvedValue(sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1])).toHaveProperty('temperature');
    expect(rejectsSampling('claude-opus-5')).toBe(false);
  });

  it('drops the sampling parameter entirely when a model rejects both knobs', async () => {
    // The dead end a single flip left the user in: the version rule guesses
    // effort, the API wants neither, and the turn used to die on the retry.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`output_config` is not supported for this model.'))
      .mockResolvedValueOnce(samplingError('`temperature` is deprecated for this model.'))
      .mockResolvedValue(sseResponse(DONE_STREAM));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const last = bodyOf(fetchMock.mock.calls[2]);
    expect(last.temperature).toBeUndefined();
    expect(last.output_config).toBeUndefined();

    // And the next turn opens on the shape that worked rather than paying for
    // the same two rejections again.
    expect(firstSamplingShape('claude-opus-5')).toBe('neither');
  });

  it('gives up once every shape has been rejected', async () => {
    // A fresh Response per call: a body can only be read once, so reusing one
    // would end the ladder early for reasons the API never gave.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => samplingError('`temperature` is deprecated for this model.'));

    const provider = new AnthropicProvider(apiKeyCfg);
    await expect(
      drain(provider.chat({ model: 'claude-sonnet-4-6', messages: [], system: '' } as never)),
    ).rejects.toThrow(/anthropic 400/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('remembers only the shape that actually worked', async () => {
    // A flip that is itself rejected must not be recorded as the answer.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`temperature` is deprecated for this model.'))
      .mockResolvedValue(sseResponse(DONE_STREAM));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-4-6', messages: [], system: '' } as never));

    expect(firstSamplingShape('claude-opus-4-6')).toBe('effort');
  });

  it('surfaces an error the stream reports after it was accepted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse(['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']),
    );

    const provider = new AnthropicProvider(apiKeyCfg);
    await expect(
      drain(provider.chat({ model: 'claude-sonnet-4-6', messages: [], system: '' } as never)),
    ).rejects.toThrow(/Overloaded/);
  });

  it('does not retry a 400 that is about something else', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(samplingError('max_tokens: must be greater than 0'));

    const provider = new AnthropicProvider(apiKeyCfg);
    await expect(drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never))).rejects.toThrow(
      /anthropic 400/,
    );
    // One attempt: retrying a real failure just produces the same error twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a vendor-prefixed id, which the anchored rule would have missed', () => {
    expect(rejectsSampling('anthropic/claude-opus-5')).toBe(true);
    expect(rejectsSampling('anthropic/claude-sonnet-4-6')).toBe(false);
  });
});

describe('isSamplingParamError', () => {
  it('names the parameter the API objected to', () => {
    expect(isSamplingParamError(400, '`temperature` is deprecated for this model.')).toBe('temperature');
    expect(isSamplingParamError(400, 'top_p: unsupported parameter')).toBe('temperature');
    expect(isSamplingParamError(400, '`output_config` is not supported')).toBe('effort');
  });

  it('ignores anything that is not a 400 about a sampling parameter', () => {
    expect(isSamplingParamError(429, '`temperature` is deprecated')).toBeNull();
    expect(isSamplingParamError(400, 'credit balance is too low')).toBeNull();
    // A model *name* containing the word must not be mistaken for a complaint.
    expect(isSamplingParamError(400, 'model `temperature-test` not found')).toBeNull();
  });
});

describe('nextSamplingShape', () => {
  it('flips to the other named knob before falling back to neither', () => {
    expect(nextSamplingShape('temperature', new Set(['temperature'] as const))).toBe('effort');
    expect(nextSamplingShape('effort', new Set(['effort'] as const))).toBe('temperature');
  });

  it('falls back to no sampling parameter once both named knobs are spent', () => {
    expect(nextSamplingShape('effort', new Set(['temperature', 'effort'] as const))).toBe('neither');
  });

  it('has nothing left after neither', () => {
    expect(nextSamplingShape('neither', new Set(['temperature', 'effort', 'neither'] as const))).toBeNull();
  });
});

describe('output cap', () => {
  beforeEach(() => resetLearnedSampling());
  afterEach(() => vi.restoreAllMocks());
  const samplingError = (message: string) =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400 });
  const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* drain */ } };

  it('sends the model ceiling when the request carries no cap, and the smaller of the two when it does', () => {
    expect(outputCapFor('claude-opus-5-5', undefined)).toBe(64_000);
    expect(outputCapFor('claude-opus-4-1', undefined)).toBe(32_000);
    expect(outputCapFor('claude-opus-5-5', 220)).toBe(220);
    expect(outputCapFor('claude-opus-4-1', 100_000)).toBe(32_000);
  });

  it('keeps a lower ceiling the API reported', () => {
    learnOutputLimit('anthropic/claude-opus-5-5', 16_000);
    expect(outputCapFor('claude-opus-5-5', undefined)).toBe(16_000);
    resetLearnedSampling();
    expect(outputCapFor('claude-opus-5-5', undefined)).toBe(64_000);
  });

  it('reads the ceiling out of a max_tokens 400 and nothing else', () => {
    expect(outputLimitError(400, '{"error":{"message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1"}}')).toBe(32_000);
    expect(outputLimitError(400, 'max_tokens: must be greater than 0')).toBeNull();
    expect(outputLimitError(429, 'max_tokens: 64000 > 32000')).toBeNull();
    expect(outputLimitError(400, 'prompt is too long. max_tokens: 64000 > 32000')).toBe(32_000);
  });

  it('retries once with the reported ceiling and remembers it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-5'))
      .mockResolvedValue(sseResponse(DONE_STREAM));
    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].max_tokens).toBe(64_000);
    expect(bodies[1].max_tokens).toBe(32_000);
    expect(outputCapFor('claude-opus-5', undefined)).toBe(32_000);
  });
});
