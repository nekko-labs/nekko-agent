import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, expect, it, vi } from 'vitest';
import type { EngineSettings, GpuStats, LoadParams, LocalModel } from '@nekko-agent/shared';
import { DEFAULT_ENGINE_SETTINGS, unsupportedLoadReason } from '@nekko-agent/shared';
import type { DaemonChild, DaemonSpawnSpec, EngineDaemon } from './daemon.js';
import { diffusionArgs } from './diffusion.js';
import { engineMemory, imageGenerationBody, reservesEndpoint } from './index.js';
import { mlxArgs } from './mlx.js';
import { buildArgs, createEngineServer, explainLoadError, probeFlags, resolveCompanions, type ModelCompanions } from './server.js';
import { isMissingDllExit, missingDllMessage } from './vc-runtime.js';

/**
 * The model server's policy (`engine:status`, `engine:settings`,
 * `engine:residentTtl`, `engine:generateImage`, and the router's
 * `engine:routerLoad`, `engine:routerModels`, `engine:routerModel`) as the
 * TS host runs it under the engine daemon, which the daemon's port
 * (crates/nekko-engine `server`) must reproduce as text, key order included:
 * the `llama-server`, `sd-server` and `mlx_lm.server` command lines, the
 * companion files a load finds or extracts, the sentence a dead server's log
 * becomes, which models load, which are evicted and when, what the router is
 * told, and the status the Models page reads, over a scripted daemon. Paths
 * are recorded below `<root>` with `/` separators, log lines without their
 * clock. Writes crates/nekko-engine/tests/golden/server.json; fails if it is
 * stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'server.json');
const NOW = 1_700_000_000_000;

function norm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split(root).join('<root>').replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map((x) => norm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(root, x)]));
  return v;
}

function denorm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split('<root>').join(root);
  if (Array.isArray(v)) return v.map((x) => denorm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, denorm(root, x)]));
  return v;
}

/** A status with each log line's clock (`HH:MM:SS `) taken off. */
function unclock(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { log?: unknown }).log)) {
    return { ...v, log: (v as { log: string[] }).log.map((l) => l.replace(/^\d\d:\d\d:\d\d /, '')) };
  }
  return v;
}

const row = (over: Partial<LocalModel>): LocalModel => ({
  id: 'm', name: 'M', path: '<root>/models/m.gguf', sizeBytes: 4_000_000_000, layers: 32, maxContext: 32768, addedAt: 1_600_000_000_123, ...over,
});

/* ------------------------------------------------------------- pure parts */

const FLAG_SETS: Record<string, string[]> = {
  none: [],
  all: ['--load-mode', '--cache-reuse', '--cache-ram', '--no-cache-idle-slots', '--spec-default', '--spec-draft-model'],
  old: ['--cache-reuse', '--spec-default'],
};

const ARG_CASES: Array<{ model: LocalModel; params: LoadParams; companions?: ModelCompanions; flags: string; caching?: boolean }> = [
  { model: row({}), params: {}, flags: 'none' },
  { model: row({}), params: { contextTokens: 8192, gpuLayers: 20, parallelSlots: 4, batchSize: 512, ubatchSize: 256, threads: 8, kvCacheDtype: 'q8_0', flashAttention: true, ropeFreqBase: 10000, ropeFreqScale: 0.5, seed: 42 }, flags: 'all' },
  { model: row({}), params: { gpuLayers: 0, parallelSlots: 1, kvCacheDtype: 'f16', flashAttention: false, mmap: false, mlock: true, seed: 0 }, flags: 'all' },
  { model: row({}), params: { mmap: false, mlock: true }, flags: 'old' },
  { model: row({}), params: { mlock: true }, flags: 'all' },
  { model: row({}), params: { speculative: false }, flags: 'all', caching: false },
  { model: row({}), params: {}, companions: { mmproj: '<root>/models/mmproj.gguf', chatTemplateFile: '<root>/t.jinja', draftModel: '<root>/models/draft.gguf' }, flags: 'all' },
  { model: row({}), params: {}, companions: { draftModel: '<root>/models/draft.gguf' }, flags: 'old' },
  { model: row({ architecture: 'nomic-bert' }), params: { contextTokens: 2048 }, flags: 'all' },
  { model: row({ architecture: 'BertModel' }), params: {}, flags: 'none', caching: false },
];

const LOGS: string[][] = [
  ['llama_model_load: error loading model: unknown model architecture: \'qwen9\''],
  ['gguf_init_from_file: invalid magic characters'],
  ['clip_model_load: failed to load mmproj'],
  ['error: chat template not supported'],
  ['llama_model_load: error loading model: missing tensor \'blk.0.attn_q.weight\''],
  ['ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory'],
  // Forward slashes: `basename` splits on them on every platform.
  ['llama_model_load: error: failed to open \'/models/x/shard-00002-of-00002.gguf\': No such file'],
  ['error: unable to read file "/models/tokenizer.json"'],
  ['I srv  load_model: loading model', 'E llama_model_load: error loading model: create_model: something exotic happened', 'main: exiting due to model loading error'],
  ['some line', 'cleaning up before exit', 'exiting due to model loading error'],
  ['first', 'second', 'third'],
  [],
  ['error loading model: tiny'],
];

const HELP = [
  'usage: llama-server [options]\n  --load-mode MODE  how to load\n  --cache-reuse N\n  -h, --help\n  --Upper-not --spec-default\n',
  '',
  'no flags at all',
];
const ASKED = ['--load-mode', '--cache-reuse', '--help', '--spec-default', '--Upper-not', '--cache-ram'];

const UNSUPPORTED = [
  row({ format: 'mlx', mlxRunnable: false }),
  row({ format: 'mlx', mlxRunnable: true }),
  row({ modality: 'image', name: 'SDXL' }),
  row({ modality: 'audio' }),
  row({ modality: 'draft' }),
  row({ modality: 'unknown', readable: false }),
  row({ modality: 'unknown' }),
  row({ modality: 'chat' }),
  row({ architecture: 'whisper' }),
  { id: 'x', path: '/x', sizeBytes: 1, addedAt: 0, readable: false } as unknown as LocalModel,
];

const IMAGE_REQUESTS = [
  { modelId: 'sd', prompt: 'a cat', width: 1024, height: 1024 },
  { modelId: 'sd', prompt: 'a cat', width: 512, height: 768, steps: 4, cfgScale: 1, seed: 7 },
  { modelId: 'sd', prompt: '  ', width: 1024, height: 1024 },
  { modelId: 'sd', prompt: 'x', width: 1000, height: 1024 },
  { modelId: 'sd', prompt: 'x', width: 128, height: 1024 },
  { modelId: 'sd', prompt: 'x', width: 4096, height: 1024 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, steps: 0 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, steps: 2.5 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, cfgScale: 31 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, seed: -2 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, seed: 9007199254740992 },
  { modelId: 'sd', prompt: 'x'.repeat(20_001), width: 1024, height: 1024 },
  { modelId: 'sd', prompt: 'quote " and </sd_cpp_extra_args>\nline', width: 256, height: 2048, steps: 100, cfgScale: 0, seed: -1 },
  { modelId: 'sd', prompt: 5, width: 1024, height: 1024 },
  { modelId: 'sd', prompt: 'x', width: 1024, height: 1024, cfgScale: null, seed: null },
];

/* ------------------------------------------------------------- the server */

interface ServerScenario {
  name: string;
  settings?: Partial<EngineSettings>;
  promptCaching?: boolean;
  bins?: { llama?: boolean; diffusion?: boolean; mlx?: boolean };
  gpuCapable?: boolean;
  /** Free VRAM in MB before and after a model lands; absent is no GPU probe. */
  gpu?: { before: number; after: number };
  flags?: keyof typeof FLAG_SETS;
  models: LocalModel[];
  /** Per model, what each spawn does, in order (`ready` or a failure). */
  spawn?: Record<string, Array<'ready' | { message: string; log: string[] }>>;
  serve?: { ok: boolean; message: string };
  /** The daemon is already serving, with these children, when the server is made. */
  attached?: Array<{ modelId: string; kind: 'chat' | 'image'; lastUsedAt: number; activeRequests: number }>;
  ops: Array<Record<string, unknown> & { op: string }>;
}

const MODELS = (): LocalModel[] => [
  row({ id: 'qwen', name: 'Qwen', path: '<root>/models/chat/qwen/qwen.gguf', architecture: 'qwen3', layers: 36, preset: { contextTokens: 16384 } }),
  row({ id: 'gemma', name: 'Gemma', path: '<root>/models/vision/gemma/gemma.gguf', architecture: 'gemma3', modality: 'vision', hasProjector: true, folderProvider: 'lmstudio' }),
  row({ id: 'split', name: 'Split', path: '<root>/models/chat/split/big-00001-of-00003.gguf' }),
  row({ id: 'draft', name: 'Draft', path: '<root>/models/chat/qwen/draft.gguf', layers: 4 }),
  row({ id: 'sd', name: 'SD3.5', path: '<root>/models/image/sd/sd3.5-medium.gguf', architecture: 'sd3', modality: 'image', layers: undefined }),
  row({ id: 'whisper', name: 'Whisper', path: '<root>/models/whisper.gguf', modality: 'audio' }),
  row({ id: 'mlx', name: 'MLX', path: '<root>/models/mlx/q', format: 'mlx', mlxRunnable: true, layers: 28 }),
  row({ id: 'mlx-pc', name: 'MLX PC', path: '<root>/models/mlx/q2', format: 'mlx', mlxRunnable: false }),
  row({ id: 'embed', name: 'Embed', path: '<root>/models/embed.gguf', architecture: 'bert', maxContext: undefined }),
];

const FILES: Record<string, string> = {
  'models/chat/qwen/qwen.gguf': 'x',
  'models/chat/qwen/draft.gguf': 'x',
  'models/chat/qwen/tokenizer_config.json': JSON.stringify({ chat_template: [{ name: 'tool_use', template: '{{tools}}' }, { name: 'default' }] }),
  'models/vision/gemma/gemma.gguf': 'x',
  'models/vision/gemma/mmproj-gemma-f16.gguf': 'x',
  'models/vision/gemma/gemma.chat_template.jinja': '{{gemma}}',
  'models/chat/split/big-00001-of-00003.gguf': 'x',
  'models/chat/split/big-00002-of-00003.gguf': 'x',
  'models/image/sd/sd3.5-medium.gguf': 'x',
  'models/image/sd/clip_l.safetensors': 'x',
  'models/image/sd/clip_g.safetensors': 'x',
  'models/image/sd/t5xxl_fp8.safetensors': 'x',
  'models/.companions/image/taesd-sd3.safetensors': 'x',
  'models/embed.gguf': 'x',
  'models/whisper.gguf': 'x',
  'models/mlx/q/config.json': '{}',
  'engine/llama-server.exe': 'x',
  'engine/sd-server.exe': 'x',
  'engine/mlx_lm.server': 'x',
};

const SCENARIOS: ServerScenario[] = [
  {
    name: 'start, load, reload, evict, unload, stop',
    settings: { port: 11600, bind: 'lan', apiKey: 'k', corsOrigins: 'http://a.test, *, ', maxLoaded: 2, autoload: ['qwen', 'gone'] },
    bins: { llama: true, diffusion: true },
    flags: 'all',
    models: MODELS(),
    spawn: { qwen: ['ready', 'ready'], gemma: ['ready'], embed: ['ready'], draft: ['ready'] },
    ops: [
      { op: 'status' },
      { op: 'start' },
      { op: 'settle' },
      { op: 'start' },
      { op: 'status' },
      { op: 'load', id: 'gemma', params: { gpuLayers: 10, draftModelId: 'draft' } },
      { op: 'load', id: 'qwen', params: { contextTokens: 16384 } },
      { op: 'load', id: 'qwen', params: { contextTokens: 16384, ttlSeconds: 60 } },
      { op: 'advance', ms: 1000 },
      { op: 'touch', id: 'gemma', activeRequests: 1 },
      { op: 'load', id: 'embed', params: {} },
      { op: 'resident' },
      { op: 'touch', id: 'gemma', activeRequests: 0 },
      { op: 'load', id: 'qwen', params: { contextTokens: 8192 } },
      { op: 'resident' },
      { op: 'unload', id: 'nope' },
      { op: 'unload', id: 'qwen' },
      { op: 'ttl', id: 'gemma', ttl: 0 },
      { op: 'ttl', id: 'gemma', ttl: 120 },
      { op: 'ttl', id: 'nope', ttl: 5 },
      { op: 'reconfigure' },
      { op: 'stop' },
      { op: 'stop' },
      { op: 'reconfigure' },
      { op: 'status' },
    ],
  },
  {
    name: 'loads that are refused or fail',
    settings: { maxLoaded: 1 },
    bins: { llama: true },
    gpuCapable: false,
    flags: 'none',
    models: MODELS(),
    spawn: { qwen: [{ message: 'The model server exited (exit code: 1).', log: ['llama_model_load: error loading model: failed to allocate buffer', 'x', 'y', 'z', 'w'] }, 'ready'], embed: [{ message: 'exit status: 0xc0000135', log: [] }], gemma: ['ready'] },
    ops: [
      { op: 'start' },
      { op: 'settle' },
      { op: 'load', id: 'nope', params: {} },
      { op: 'load', id: 'sd', params: {} },
      { op: 'load', id: 'whisper', params: {} },
      { op: 'load', id: 'mlx', params: {} },
      { op: 'load', id: 'mlx-pc', params: {} },
      { op: 'load', id: 'split', params: {} },
      { op: 'load', id: 'qwen', params: { draftModelId: 'mlx' } },
      { op: 'load', id: 'embed', params: {} },
      { op: 'load', id: 'qwen', params: {} },
      { op: 'touch', id: 'qwen', activeRequests: 2 },
      { op: 'load', id: 'gemma', params: {} },
      { op: 'touch', id: 'qwen', activeRequests: 0 },
      { op: 'load', id: 'gemma', params: {} },
      { op: 'status' },
    ],
  },
  {
    name: 'the router asks, and idle models are swept',
    settings: { jitLoad: true, idleTtlSeconds: 60 },
    bins: { llama: true, diffusion: true, mlx: true },
    flags: 'old',
    gpu: { before: 20_000, after: 14_000 },
    models: MODELS(),
    spawn: { qwen: ['ready'], sd: ['ready'], mlx: ['ready'], gemma: ['ready'] },
    ops: [
      { op: 'start' },
      { op: 'settle' },
      { op: 'routerModels' },
      { op: 'routerModel', id: 'gemma' },
      { op: 'routerModel', id: 'nope' },
      { op: 'routerLoad', id: 'nope', image: false },
      { op: 'routerLoad', id: 'sd', image: false },
      { op: 'routerLoad', id: 'qwen', image: true },
      { op: 'routerLoad', id: 'qwen', image: false },
      { op: 'routerLoad', id: 'qwen', image: false },
      { op: 'routerLoad', id: 'sd', image: true },
      { op: 'routerLoad', id: 'mlx', image: false },
      { op: 'resident' },
      { op: 'ttl', id: 'qwen', ttl: 0 },
      { op: 'advance', ms: 61_000 },
      { op: 'sweep' },
      { op: 'resident' },
      { op: 'crash', id: 'qwen' },
      { op: 'sync' },
      { op: 'setSettings', settings: { jitLoad: false } },
      { op: 'routerLoad', id: 'gemma', image: false },
      { op: 'routerModels' },
      { op: 'status' },
    ],
  },
  {
    name: 'a daemon that will not serve, and nothing installed',
    bins: {},
    models: MODELS(),
    serve: { ok: false, message: 'Port 11500 is already in use. Pick another port for the engine.' },
    ops: [{ op: 'start' }, { op: 'status' }, { op: 'load', id: 'qwen', params: {} }, { op: 'load', id: 'sd', params: {} }],
  },
  {
    name: 'a refused port',
    bins: { llama: true },
    models: MODELS(),
    serve: { ok: false, message: 'Port 11500 is already in use. Pick another port for the engine.' },
    ops: [{ op: 'start' }, { op: 'status' }],
  },
  {
    // A LAN bind without a key never reaches the daemon (#549): start refuses,
    // a key lets it through, and clearing the key again is refused on
    // reconfigure while the listener keeps its last good configuration.
    name: 'a LAN bind without a key is refused',
    settings: { bind: 'lan', apiKey: '' },
    bins: { llama: true },
    models: MODELS(),
    ops: [
      { op: 'start' },
      { op: 'status' },
      { op: 'setSettings', settings: { apiKey: '   ' } },
      { op: 'start' },
      { op: 'setSettings', settings: { apiKey: 'secret' } },
      { op: 'start' },
      { op: 'setSettings', settings: { apiKey: '' } },
      { op: 'reconfigure' },
      { op: 'setSettings', settings: { bind: 'local' } },
      { op: 'reconfigure' },
      { op: 'status' },
    ],
  },
  {
    name: 'a backend restarted under a serving daemon',
    settings: { idleTtlSeconds: 0 },
    bins: { llama: true },
    gpuCapable: true,
    models: MODELS(),
    attached: [
      { modelId: 'qwen', kind: 'chat', lastUsedAt: NOW - 5000, activeRequests: 0 },
      { modelId: 'ghost', kind: 'chat', lastUsedAt: NOW - 9000, activeRequests: 1 },
    ],
    ops: [{ op: 'reattach' }, { op: 'status' }, { op: 'sweep' }, { op: 'routerModels' }, { op: 'stop' }],
  },
];

function fakeDaemon(s: ServerScenario, clock: () => number, gpuState: { landed: boolean }) {
  const children = new Map<string, DaemonChild>();
  const calls: unknown[] = [];
  let serving: { port: number; host: string } | null = s.attached ? { port: 11500, host: '127.0.0.1' } : null;
  let n = 0;
  for (const a of s.attached ?? []) {
    n += 1;
    children.set(a.modelId, { modelId: a.modelId, kind: a.kind, port: 40000 + n, pid: 1000 + n, startedAt: NOW - 60_000, lastUsedAt: a.lastUsedAt, activeRequests: a.activeRequests });
  }
  const spawnQueue = new Map(Object.entries(s.spawn ?? {}).map(([k, v]) => [k, [...v]]));
  const daemon: EngineDaemon = {
    serve: async (cfg) => {
      calls.push({ serve: cfg });
      const res = s.serve ?? { ok: true, message: `Listening on ${cfg.host}:${cfg.port}` };
      if (res.ok) serving = { port: cfg.port, host: cfg.host };
      return res;
    },
    stopServing: async () => {
      calls.push({ stopServing: true });
      serving = null;
    },
    serving: async () => serving,
    spawn: async (spec: DaemonSpawnSpec) => {
      calls.push({ spawn: spec });
      const next = spawnQueue.get(spec.modelId)?.shift() ?? 'ready';
      if (next !== 'ready') return { status: 'failed', message: next.message, log: next.log };
      n += 1;
      gpuState.landed = true;
      const c = { modelId: spec.modelId, kind: spec.kind, port: 40000 + n, pid: 1000 + n, startedAt: clock(), lastUsedAt: clock(), activeRequests: 0 };
      children.set(spec.modelId, c);
      return { status: 'ready', port: c.port, pid: c.pid };
    },
    kill: async (id) => {
      calls.push({ kill: id });
      return children.delete(id);
    },
    list: async () => [...children.values()],
  };
  return { daemon, children, calls };
}

async function runServer(root: string, s: ServerScenario) {
  for (const [rel, text] of Object.entries(FILES)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  }
  let clock = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const gpuState = { landed: false };
  const fake = fakeDaemon(s, () => clock, gpuState);
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...s.settings };
  const models = denorm(root, s.models) as LocalModel[];
  const gpu = (): GpuStats | null =>
    s.gpu
      ? { source: 'nvidia-smi', devices: [{ name: 'GPU', memoryTotalMB: 24_000, memoryUsedMB: 0, memoryFreeMB: 0 }], totalMB: 24_000, usedMB: 0, freeMB: gpuState.landed ? s.gpu.after : s.gpu.before }
      : null;
  const flags = new Set(FLAG_SETS[s.flags ?? 'none']);
  const server = createEngineServer({
    settings: () => settings,
    promptCaching: () => s.promptCaching ?? true,
    binPath: async () => (s.bins?.llama ? join(root, 'engine', 'llama-server.exe') : undefined),
    diffusionBinPath: async () => (s.bins?.diffusion ? join(root, 'engine', 'sd-server.exe') : undefined),
    mlxBinPath: async () => (s.bins?.mlx ? join(root, 'engine', 'mlx_lm.server') : undefined),
    findModel: async (id) => models.find((m) => m.id === id),
    listModels: async () => models,
    getGpuStats: async () => gpu(),
    workDir: () => join(root, 'engine', 'templates'),
    companionsDir: (id) => join(root, 'models', '.companions', id.replace(/\W/g, '_')),
    imageCompanionsDir: () => join(root, 'models', '.companions', 'image'),
    flagSupport: async () => (f: string) => flags.has(f),
    gpuCapable: async () => s.gpuCapable ?? true,
    daemon: fake.daemon,
  });
  const outs: string[] = [];
  for (const op of s.ops) {
    let out: unknown = null;
    switch (op.op) {
      case 'status': out = unclock(server.status()); break;
      case 'resident': out = server.resident(); break;
      case 'start': out = await server.start(); break;
      case 'stop': out = await server.stop(); break;
      case 'reconfigure': out = await server.reconfigure(); break;
      case 'reattach': out = await server.reattach(); break;
      case 'load': out = await server.load(op.id as string, op.params as LoadParams); break;
      case 'unload': out = await server.unload(op.id as string); break;
      case 'ttl': out = server.setResidentTtl(op.id as string, op.ttl as number); break;
      case 'routerLoad': out = await server.routerLoad(op.id as string, op.image as boolean); break;
      case 'routerModels': out = await server.routerModels(); break;
      case 'routerModel': out = await server.routerModel(op.id as string); break;
      case 'sync': out = await server.sync(); break;
      case 'sweep': out = await server.sweepIdle(); break;
      case 'advance': clock += op.ms as number; break;
      case 'setSettings': Object.assign(settings, op.settings); break;
      case 'touch': {
        const c = fake.children.get(op.id as string);
        if (c) { c.lastUsedAt = clock; c.activeRequests = op.activeRequests as number; }
        break;
      }
      case 'crash': fake.children.delete(op.id as string); break;
      case 'settle': {
        // Autoload runs after start returns; wait for it to drain.
        await new Promise((r) => setTimeout(r, 30));
        for (let i = 0; i < 500 && (server.status().loading?.length ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 30));
        break;
      }
    }
    outs.push(JSON.stringify(norm(root, out ?? null)));
  }
  const templates = await readdir(join(root, 'engine', 'templates')).catch(() => [] as string[]);
  const extracted: Record<string, string> = {};
  for (const t of templates.sort()) extracted[t] = await readFile(join(root, 'engine', 'templates', t), 'utf8');
  await server.stop();
  return { outs, calls: norm(root, fake.calls), templates: extracted };
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  vi.useRealTimers();
});

it('matches the server golden set the engine daemon replays', { timeout: 120_000 }, async () => {
  // The sweeper, the residency sync and the load-progress sampler never fire
  // here: the scenarios call them, so their timing cannot change the record.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const root = await mkdtemp(join(tmpdir(), 'nekko-server-golden-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(FILES)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  }

  const args = ARG_CASES.map((c) => {
    const flags = new Set(FLAG_SETS[c.flags]);
    const model = denorm(root, c.model) as LocalModel;
    const companions = denorm(root, c.companions) as ModelCompanions | undefined;
    return { ...c, out: norm(root, buildArgs(model, '{port}', c.params, companions, (f) => flags.has(f), c.caching ?? true)) };
  });
  const explained = LOGS.map((log) => ({ log, out: explainLoadError(log) }));
  const help = [];
  for (const text of HELP) {
    const supports = await probeFlags(`fake-bin-${help.length}`, async (bin) => (text ? text : Promise.reject(new Error(`no help from ${bin}`))));
    help.push({ text, out: ASKED.map((f) => supports(f)) });
  }
  const unsupported = UNSUPPORTED.map((m) => ({ model: m, out: unsupportedLoadReason(m) ?? null }));
  const dll = ['The model server exited (exit status: 0xc0000135)', 'exit code: 3221225781', 'code -1073741515', 'exit code: 1', '', null].map((m) => ({ message: m, out: isMissingDllExit(m) }));
  const dllMessages = [missingDllMessage(), missingDllMessage('The image server')];
  const images = IMAGE_REQUESTS.map((r) => ({ request: r, out: JSON.stringify(imageGenerationBody(r as never)) }));
  const memory = [
    [null, 32 * 2 ** 30],
    [{ source: 'nvidia-smi', devices: [], totalMB: 0, usedMB: 0, freeMB: 0 }, 16 * 2 ** 30],
    [{ source: 'nvidia-smi', devices: [{ name: 'x', memoryTotalMB: 24000, memoryUsedMB: 0, memoryFreeMB: 0 }], totalMB: 24000, usedMB: 0, freeMB: 0 }, 1],
    [{ source: 'ioreg', devices: [{ name: 'M3', memoryTotalMB: 36864, memoryUsedMB: 0, memoryFreeMB: 0 }], totalMB: 36864, usedMB: 0, freeMB: 0, unified: true }, 1],
  ].map(([gpu, total]) => ({ gpu, total, out: engineMemory(gpu as GpuStats | null, total as number) }));
  const reserves = [{}, { port: 1 }, { bind: 'lan' }, { apiKey: '' }, { corsOrigins: '*' }, { idleTtlSeconds: 5, autoload: [] }].map((patch) => ({ patch, out: reservesEndpoint(patch as never) }));

  // Companion files a load finds, and templates it extracts.
  const companions = [];
  for (const m of MODELS()) {
    const model = denorm(root, m) as LocalModel;
    const out = await resolveCompanions(model, join(root, 'engine', 'templates'), join(root, 'models', '.companions', m.id));
    companions.push({ id: m.id, out: norm(root, out) });
  }
  const sd = denorm(root, MODELS().find((m) => m.id === 'sd')) as LocalModel;
  const diffusion = [];
  for (const preset of [undefined, { offloadToCpu: true, clipOnCpu: true }, { standalone: false }, { vae: join(root, 'missing.safetensors') }, { t5xxl: '' }]) {
    const model = { ...sd, preset: preset ? { diffusion: preset } : undefined } as LocalModel;
    let out: unknown;
    try {
      out = await diffusionArgs(model, '{port}', join(root, 'models', '.companions', 'sd'), join(root, 'models', '.companions', 'image'));
    } catch (e) {
      out = { error: (e as Error).message };
    }
    diffusion.push({ preset: norm(root, preset) ?? null, out: norm(root, out) });
  }
  const flux = denorm(root, row({ id: 'flux', name: 'FLUX.1 dev', path: '<root>/models/flux1-dev.gguf', modality: 'image' })) as LocalModel;
  try {
    await diffusionArgs(flux, 1234, undefined, join(root, 'models', '.companions', 'image'));
  } catch (e) {
    diffusion.push({ preset: 'flux', out: { error: norm(root, (e as Error).message) } });
  }
  const mlx = [[{}, undefined], [{}, '<root>/d'], [{ speculative: false }, '<root>/d']].map(([params, draft]) => ({
    params, draft: draft ?? null, out: norm(root, mlxArgs(denorm(root, MODELS()[6]) as LocalModel, 9000, params as LoadParams, draft ? (denorm(root, draft) as string) : undefined)),
  }));

  const scenarios = [];
  for (const s of SCENARIOS) {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-server-scn-'));
    roots.push(dir);
    scenarios.push({ ...s, result: await runServer(dir, s) });
  }
  vi.useRealTimers();

  const expected = {
    note: 'Generated by packages/host/src/engine/server.golden.test.ts. Do not edit by hand.',
    now: NOW,
    files: FILES,
    flagSets: FLAG_SETS,
    args,
    explained,
    help,
    asked: ASKED,
    unsupported,
    dll,
    dllMessages,
    images,
    memory,
    reserves,
    companions,
    diffusion,
    mlx,
    models: MODELS(),
    scenarios,
  };
  const text = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, text);
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
});
