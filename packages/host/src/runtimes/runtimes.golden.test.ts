import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { expect, it } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import { setDataDir } from '../paths.js';
import { createRuntimes } from './index.js';
import type { Engine } from '../engine/index.js';

/**
 * The runtime control plane (`runtime:*`) as the TS host runs it over Ollama,
 * LM Studio (local and remote), vLLM and the engine, which the engine
 * daemon's port (crates/nekko-engine `runtimes`) must reproduce: the same
 * answers, the same HTTP requests and CLI runs, the same engine calls and the
 * same calibration file. The servers are a scripted fetch, the CLIs a scripted
 * `run`, the engine a scripted stand-in. Writes
 * crates/nekko-engine/tests/golden/runtimes.json; fails if it is stale
 * (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'runtimes.json');

const PROVIDERS = [
  { id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
  { id: 'lms', kind: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1/' },
  { id: 'lms-remote', kind: 'lmstudio', name: 'LM Studio (lab)', baseUrl: 'http://10.0.0.5:1234/v1' },
  { id: 'vllm', kind: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'nekko-engine', kind: 'llamacpp', name: 'Nekko engine', baseUrl: 'http://127.0.0.1:18431/v1' },
  { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
] as unknown as ProviderConfig[];

const SHOW = (layers: number, heads: number, kv: number, embed: number, ctx: number) =>
  JSON.stringify({ details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' }, model_info: { 'general.architecture': 'qwen3', 'qwen3.block_count': layers, 'qwen3.attention.head_count': heads, 'qwen3.attention.head_count_kv': kv, 'qwen3.embedding_length': embed, 'qwen3.context_length': ctx, 'qwen3.rope.freq_base': 'x' } });

/** `METHOD url body` -> reply. Anything else is a 404. */
const HTTP: Record<string, { status: number; body: string } | 'throw'> = {
  'GET http://127.0.0.1:11434/api/version ': { status: 200, body: '{"version":"0.12.3"}' },
  'GET http://127.0.0.1:11434/api/ps ': { status: 200, body: JSON.stringify({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6_000_000_000, size_vram: 5_500_000_000, context_length: 8192, expires_at: '2026-10-12T10:00:00Z', details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }, { model: 'embed:latest', size: 300_000_000, expires_at: 'soon' }] }) },
  'GET http://127.0.0.1:11434/api/tags ': { status: 200, body: JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5_200_000_000 }, { name: 'llama3.2:3b', size: 2_000_000_000 }, { model: 'embed:latest', size: 300_000_000 }, { name: '' }, { name: 'broken:1b' }] }) },
  'POST http://127.0.0.1:11434/api/show {"model":"qwen3:8b"}': { status: 200, body: SHOW(36, 32, 8, 4096, 40960) },
  'POST http://127.0.0.1:11434/api/show {"model":"llama3.2:3b"}': { status: 200, body: JSON.stringify({ details: { parameter_size: '3.2B' }, model_info: { 'llama.block_count': 28, 'llama.attention.head_count': 24, 'llama.embedding_length': 3072, 'llama.context_length': 131072 } }) },
  'POST http://127.0.0.1:11434/api/show {"model":"embed:latest"}': { status: 200, body: 'not json' },
  'POST http://127.0.0.1:11434/api/show {"model":"broken:1b"}': { status: 500, body: '' },
  'POST http://127.0.0.1:11434/api/generate {"model":"qwen3:8b","prompt":"","options":{"num_ctx":16384,"num_gpu":20},"keep_alive":"300s"}': { status: 200, body: '{}' },
  'POST http://127.0.0.1:11434/api/generate {"model":"llama3.2:3b","prompt":"","options":{}}': { status: 500, body: 'no' },
  'POST http://127.0.0.1:11434/api/generate {"model":"qwen3:8b","prompt":"","keep_alive":0}': { status: 200, body: '{}' },
  'GET http://localhost:1234/api/v0/models ': { status: 200, body: JSON.stringify({ data: [{ id: 'qwen/qwen3-4b', state: 'loaded', type: 'llm', quantization: 'Q4_K_M', max_context_length: 32768, loaded_context_length: 8192 }, { id: 'google/gemma-3-12b', state: 'not-loaded', max_context_length: 131072 }, { id: 'nomic-embed', state: 'not-loaded' }] }) },
  'GET http://localhost:1234/v1/models ': { status: 200, body: '{"data":[]}' },
  'GET http://10.0.0.5:1234/api/v0/models ': 'throw',
  'GET http://10.0.0.5:1234/v1/models ': { status: 200, body: '{"data":[{"id":"x"}]}' },
  'GET http://127.0.0.1:8000/v1/models ': { status: 200, body: JSON.stringify({ data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct', max_model_len: 32768 }] }) },
  'GET http://127.0.0.1:8000/metrics ': { status: 200, body: '# HELP vllm:num_requests_running x\nvllm:num_requests_running{model_name="m"} 2.0\nvllm:num_requests_waiting{model_name="m"} 0\nvllm:kv_cache_usage_perc{model_name="m"} 0.375\n' },
};

/** `cmd args...` -> output (null: the CLI is missing or failed). The cmd is its base name. */
const RUN: Record<string, string | null> = {
  'ollama --version': 'ollama version is 0.12.3',
  'lms version': '\u001b[1mlms\u001b[0m - LM Studio CLI - v0.3.27\n',
  'lms ls --json': 'Loading...\n' + JSON.stringify([{ type: 'llm', modelKey: 'qwen/qwen3-4b', sizeBytes: 2_500_000_000, paramsString: '4B', quantization: { name: 'Q4_K_M', bits: 4 }, maxContextLength: 32768 }, { type: 'llm', modelKey: 'google/gemma-3-12b', sizeBytes: 8_100_000_000, paramsString: '12B', maxContextLength: 131072 }, { type: 'embedding' }]),
  'lms load qwen/qwen3-4b -y --context-length 8192 --gpu max --ttl 60': 'Model loaded successfully in 3.2s',
  'lms load google/gemma-3-12b -y --gpu off': 'Error: Model not found\nTry lms ls\nthird line',
  'lms unload qwen/qwen3-4b': 'Model unloaded.',
  'lms server start --port 1234': 'Success! Server is now running on port 1234\n',
  'lms server stop': 'Stopped the server on port 1234.',
};

const ENGINE_STATUS = { running: true, install: { binPath: 'C:/engine/llama-server.exe', version: 'b6000' }, startedAt: 1_700_000_000_000, resident: [{ id: 'gemma', sizeBytes: 4_200_000_000, vramBytes: 4_000_000_000, contextLength: 4096 }], log: ['server ready'], port: 18431 };

/** The engine, scripted, recording each call (a daemon forwards these to the host). */
function fakeEngine(calls: unknown[]): Engine {
  const call = (method: string, result: unknown) => async (...args: unknown[]) => { calls.push([method, ...args]); return result; };
  return {
    detectEngine: call('detectEngine', { binPath: 'C:/engine/llama-server.exe', version: 'b6000' }),
    isRunning: (...args: unknown[]) => { calls.push(['isRunning', ...args]); return true; },
    status: call('status', ENGINE_STATUS),
    models: call('models', [{ id: 'gemma', sizeBytes: 3_300_000_000, layers: 34, kvHeads: 4, headDim: 256, maxContext: 131072, quantization: 'Q4_K_M', parameterSize: '4B', loaded: true }, { id: 'nogeo', sizeBytes: 1_000_000, loaded: false }]),
    resident: (...args: unknown[]) => { calls.push(['resident', ...args]); return ENGINE_STATUS.resident; },
    start: call('start', { ok: false, message: 'Port 18431 is in use.' }),
    stop: call('stop', { ok: true, message: 'Stopped the engine.' }),
    load: call('load', { ok: true, message: 'Loaded gemma' }),
    unload: call('unload', { ok: true, message: 'Unloaded gemma' }),
  } as unknown as Engine;
}

type Step = [op: string, ...args: unknown[]];
const STEPS: Step[] = [
  ['status', 'ollama'],
  ['facts', 'ollama'],
  ['plan', 'ollama', 'qwen3:8b'],
  ['plan', 'ollama', 'llama3.2:3b', { contextTokens: 131072, parallelSlots: 2, kvCacheDtype: 'q8_0', gpuLayerFraction: 1 }],
  ['plan', 'ollama', 'missing'],
  ['autoPlan', 'ollama', 'qwen3:8b', 0.5, 2],
  ['load', 'ollama', 'qwen3:8b', { contextTokens: 16384, gpuLayers: 20, ttlSeconds: 300 }],
  ['load', 'ollama', 'llama3.2:3b', {}],
  ['unload', 'ollama', 'qwen3:8b'],
  ['start', 'ollama'],
  ['stop', 'ollama'],
  ['capabilities', 'ollama'],
  ['status', 'lms'],
  ['facts', 'lms'],
  ['load', 'lms', 'qwen/qwen3-4b', { contextTokens: 8192, gpuLayers: 18, ttlSeconds: 60 }],
  ['load', 'lms', 'google/gemma-3-12b', { gpuLayers: 0 }],
  ['unload', 'lms', 'qwen/qwen3-4b'],
  ['start', 'lms'],
  ['stop', 'lms'],
  ['status', 'lms-remote'],
  ['stop', 'lms-remote'],
  ['load', 'lms-remote', 'x', {}],
  ['status', 'vllm'],
  ['facts', 'vllm'],
  ['start', 'vllm'],
  ['load', 'vllm', 'x', {}],
  ['unload', 'vllm', 'x'],
  ['stop', 'vllm'],
  ['status', 'nekko-engine'],
  ['facts', 'nekko-engine'],
  ['plan', 'nekko-engine', 'gemma', { contextTokens: 32768, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 }],
  ['load', 'nekko-engine', 'gemma', { contextTokens: 4096 }],
  ['unload', 'nekko-engine', 'gemma'],
  ['start', 'nekko-engine'],
  ['stop', 'nekko-engine'],
  ['autoPlan', 'nekko-engine', 'nogeo', 1],
  ['status', 'openai'],
  ['start', 'openai'],
  ['stop', 'openai'],
  ['load', 'openai', 'gpt', {}],
  ['facts', 'openai'],
  ['plan', 'nope', 'x'],
  ['capabilities', 'openai'],
  ['capabilities', 'nekko-engine'],
];

const GB = 1024 ** 3;

it('the runtime control plane matches the daemon golden set', async () => {
  const data = mkdtempSync(join(tmpdir(), 'nekko-runtimes-golden-'));
  setDataDir(data);
  const calls: unknown[] = [];
  const requests: unknown[] = [];
  const runs: unknown[] = [];
  const runtimes = createRuntimes({
    findProvider: (id) => PROVIDERS.find((p) => p.id === id),
    getGpuStats: async () => ({ source: 'nvidia-smi', devices: [{ name: 'RTX 5090', memoryTotalMB: 32607, memoryUsedMB: 2000, memoryFreeMB: 30607 }], totalMB: 32607, usedMB: 2000, freeMB: 30607 }),
    getSystemStats: async () => ({ cpuPct: 5, cpuCores: 32, memUsedMB: 30000, memTotalMB: 48270 }),
    engine: fakeEngine(calls),
    ctx: {
      fetch: (async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`;
        requests.push(key);
        const r = HTTP[key];
        if (r === 'throw') throw new TypeError('fetch failed');
        return new Response(r?.body ?? 'Not found', { status: r?.status ?? 404 });
      }) as typeof fetch,
      run: async (cmd: string, args: string[]) => {
        const key = [cmd.replace(/^.*[\\/]/, '').replace(/\.exe$/, ''), ...args].join(' ');
        runs.push(key);
        return key in RUN ? RUN[key] : null;
      },
    },
  });
  const steps = [];
  try {
    for (const [op, ...args] of STEPS) {
      const fn = (runtimes as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      let out: unknown;
      try {
        out = await fn(...args);
      } catch (e) {
        out = { thrown: (e as Error).message };
      }
      // A start's clock is the machine's.
      const text = JSON.stringify(out ?? null).replace(/"startedAt":\d{13,}/g, (m) => (m.endsWith('1700000000000') ? m : '"startedAt":"<now>"'));
      requests.sort();
      steps.push({ op, args, out: text, requests: requests.splice(0), runs: runs.splice(0), calls: JSON.parse(JSON.stringify(calls.splice(0))) });
    }
    const calibration = join(data, 'runtime-calibration.json');
    const out = {
      providers: PROVIDERS,
      http: HTTP,
      run: RUN,
      engineStatus: ENGINE_STATUS,
      steps,
      calibration: existsSync(calibration) ? readFileSync(calibration, 'utf8') : null,
      gb: GB,
    };
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(golden), { recursive: true });
      writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
    }
    expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
