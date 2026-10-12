import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import { createProvider } from './index.js';
import { resetLearnedSampling } from './anthropic.js';
import { resetLearnedParams } from './openai-compat.js';
import type { ChatRequest, ProviderChunk } from './types.js';

/**
 * What the engine daemon's Rust providers (crates/nekko-agent) must reproduce
 * exactly: the HTTP request each provider sends for a set of chat requests,
 * the chunk sequence it yields for a set of recorded response streams, and
 * the model list it maps each server's answer to.
 *
 * The inputs live beside the Rust test (make-fixtures.mjs writes them). This
 * test runs the real providers against a fake `fetch` and keeps the expected
 * files honest: change a provider and it fails until they are rewritten with
 * `UPDATE_GOLDEN=1`, which then holds the Rust port to the change.
 *
 * Time is frozen, so a decode clock that started reports exactly 1 ms and one
 * that never started reports nothing; the ChatGPT session id is random and is
 * recorded as `<session>`.
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-agent', 'tests', 'golden');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(golden, name), 'utf8')) as T;

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Each string is one network chunk. */
  chunks?: string[];
  /** The whole body, split into network chunks at `cuts` (byte offsets). */
  body?: string;
  bodyHex?: string;
  cuts?: number[];
  /** Make fetch reject with this message instead of answering. */
  networkError?: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function parts(r: FakeResponse): Uint8Array[] {
  const enc = new TextEncoder();
  if (r.chunks) return r.chunks.map((c) => enc.encode(c));
  const bytes = r.bodyHex !== undefined ? Uint8Array.from(Buffer.from(r.bodyHex, 'hex')) : enc.encode(r.body ?? '');
  const cuts = [...new Set(r.cuts ?? [])].filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) {
    out.push(bytes.slice(at, c));
    at = c;
  }
  return out.filter((p) => p.length > 0);
}

function toResponse(r: FakeResponse): Response {
  const chunks = parts(r);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
}

/** Swap fetch for one that records every request and answers from `answer`. */
function fakeFetch(answer: (url: string) => FakeResponse | undefined): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    if (headers.session_id) headers.session_id = '<session>';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ method: init?.method ?? 'GET', url, headers, body });
    const r = answer(url);
    if (!r) throw new TypeError('fetch failed');
    if (r.networkError) throw new TypeError(r.networkError);
    return toResponse(r);
  });
  return requests;
}

/** Everything a chat yields, then what it threw, if it threw. */
async function drain(chat: AsyncIterable<ProviderChunk>): Promise<unknown[]> {
  const out: unknown[] = [];
  try {
    for await (const c of chat) out.push(JSON.parse(JSON.stringify(c)));
  } catch (e) {
    out.push({ type: 'error', message: (e as Error).message });
  }
  return out;
}

function check(file: string, actual: unknown) {
  const path = join(golden, file);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
}

const providers = read<Record<string, ProviderConfig>>('providers.json');

afterEach(() => vi.restoreAllMocks());

function freezeTime() {
  vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
}

describe('provider golden set', () => {
  it('sends exactly the recorded request for every provider and request fixture', async () => {
    const cases = read<{ providers: string[]; requests: Record<string, ChatRequest> }>('request-cases.json');
    const actual: Record<string, Record<string, RecordedRequest>> = {};
    for (const p of cases.providers) {
      actual[p] = {};
      for (const [name, req] of Object.entries(cases.requests)) {
        resetLearnedSampling();
        resetLearnedParams();
        freezeTime();
        const requests = fakeFetch(() => ({ chunks: [] }));
        const chunks = await drain(createProvider(providers[p]).chat(req));
        expect(chunks, `${p}/${name}`).toEqual([{ type: 'done' }]);
        expect(requests, `${p}/${name}`).toHaveLength(1);
        actual[p][name] = requests[0];
        vi.restoreAllMocks();
      }
    }
    check('requests.json', actual);
  });

  it('yields exactly the recorded chunks for every response stream', async () => {
    const cases = read<
      Array<{ name: string; provider: string; request?: string; chats?: number; responses: FakeResponse[] }>
    >('stream-cases.json');
    const named = read<{ requests: Record<string, ChatRequest> }>('request-cases.json').requests;
    const actual: Record<string, unknown> = {};
    for (const c of cases) {
      resetLearnedSampling();
      resetLearnedParams();
      freezeTime();
      const queue = [...c.responses];
      const requests = fakeFetch(() => queue.shift());
      const onHeaders: Array<Record<string, string>> = [];
      const provider = createProvider(providers[c.provider]);
      const chats: unknown[][] = [];
      for (let i = 0; i < (c.chats ?? 1); i++) {
        const req: ChatRequest = {
          ...(named[c.request ?? 'minimal'] as ChatRequest),
          onHeaders: (h) => onHeaders.push(Object.fromEntries(h.entries())),
        };
        chats.push(await drain(provider.chat(req)));
      }
      expect(queue, `${c.name} left responses unread`).toEqual([]);
      actual[c.name] = { requests, chunks: chats, onHeaders };
      vi.restoreAllMocks();
    }
    check('streams.json', actual);
  });

  it('maps every recorded model list exactly', async () => {
    const cases = read<Array<{ name: string; provider: string; responses: Record<string, FakeResponse> }>>(
      'model-cases.json',
    );
    const actual: Record<string, unknown> = {};
    for (const c of cases) {
      const requests = fakeFetch((url) => c.responses[url]);
      try {
        const models = await createProvider(providers[c.provider]).listModels();
        actual[c.name] = { requests, models: JSON.parse(JSON.stringify(models)) };
      } catch (e) {
        actual[c.name] = { requests, error: (e as Error).message };
      }
      vi.restoreAllMocks();
    }
    check('models.json', actual);
  });

  it('answers every connection test exactly', async () => {
    const cases = read<
      Array<{ name: string; provider: string; patch?: Partial<ProviderConfig>; responses: Record<string, FakeResponse> }>
    >('test-cases.json');
    const actual: Record<string, unknown> = {};
    for (const c of cases) {
      const requests = fakeFetch((url) => c.responses[url]);
      const result = await createProvider({ ...providers[c.provider], ...c.patch }).test();
      actual[c.name] = { requests, result };
      vi.restoreAllMocks();
    }
    check('tests.json', actual);
  });
});
