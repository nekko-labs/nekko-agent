/**
 * Control-plane types for the local model servers we manage.
 *
 * The central idea is `RuntimeCapabilities`: the renderer asks what a runtime can
 * do, never what it is. Ollama and LM Studio are model managers you send models
 * to; vLLM is a process per model, configured entirely at launch. Expressing that
 * asymmetry as data instead of `if (kind === 'vllm')` is what keeps the UI honest
 * and what lets a future bundled engine drop in without touching the renderer.
 */

import type { ProviderKind } from './models.js';
import type { KvCacheDtype, ModelFacts } from './capacity.js';

/** The local model servers we manage. Mirrors LOCAL_PROVIDER_KINDS. */
export type RuntimeKind = 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp';

export function isRuntimeKind(kind: ProviderKind): kind is RuntimeKind {
  return kind === 'ollama' || kind === 'lmstudio' || kind === 'vllm' || kind === 'llamacpp';
}

/**
 * What a runtime can actually do.
 *
 * `'server-env'` means the setting exists but only as a server-wide environment
 * variable, so changing it needs a restart. The UI shows those controls disabled
 * with the env line to copy, rather than pretending they take effect per load.
 */
export interface RuntimeCapabilities {
  canStart: boolean;
  canStop: boolean;
  canLoad: boolean;
  canSetContext: boolean;
  canSetGpuLayers: boolean;
  canSetParallel: 'per-load' | 'server-env' | false;
  canSetKvCacheType: 'per-load' | 'server-env' | false;
  canSetTtl: boolean;
  /** Configuration is a launch command, not a control (vLLM). */
  configuredAtLaunch: boolean;
  /** Reports per-model VRAM, so a measurement can reconcile the projection. */
  reportsPerModelVram: boolean;
  /**
   * Nekko Agent owns this runtime end to end: it installs the engine, holds the
   * models, and configures the server. Only the managed engine sets this, and it
   * is what earns the extra surfaces (catalog, downloads, server settings) rather
   * than a kind check in the renderer.
   */
  managed?: boolean;
  /** Batch size, threads, flash attention, mmap/mlock, rope: llama.cpp flags. */
  canSetCompute?: boolean;
}

export const RUNTIME_CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  ollama: {
    canStart: true,
    canStop: true,
    canLoad: true,
    canSetContext: true,
    canSetGpuLayers: true,
    // OLLAMA_NUM_PARALLEL and OLLAMA_KV_CACHE_TYPE are read at server start.
    canSetParallel: 'server-env',
    canSetKvCacheType: 'server-env',
    canSetTtl: true,
    configuredAtLaunch: false,
    reportsPerModelVram: true,
  },
  lmstudio: {
    canStart: true,
    canStop: true,
    canLoad: true,
    canSetContext: true,
    canSetGpuLayers: true,
    canSetParallel: false,
    canSetKvCacheType: false,
    canSetTtl: true,
    configuredAtLaunch: false,
    // /api/v0/models reports load state but no per-model VRAM figure.
    reportsPerModelVram: false,
  },
  // Connect-existing only. One model per process, configured at launch, and in
  // practice Linux + NVIDIA + Python, which nothing here can verify a spawn path
  // against. We detect it, read /metrics, and can stop it. We never start it.
  vllm: {
    canStart: false,
    canStop: true,
    canLoad: false,
    canSetContext: false,
    canSetGpuLayers: false,
    canSetParallel: false,
    canSetKvCacheType: false,
    canSetTtl: false,
    configuredAtLaunch: true,
    reportsPerModelVram: false,
  },
  // The engine Nekko Agent runs itself. llama.cpp takes context, GPU layers,
  // parallel slots and KV cache type as per-load flags, which makes it the most
  // controllable runtime here rather than the least: nothing needs a restart and
  // nothing has to be set as an environment variable.
  llamacpp: {
    canStart: true,
    canStop: true,
    canLoad: true,
    canSetContext: true,
    canSetGpuLayers: true,
    canSetParallel: 'per-load',
    canSetKvCacheType: 'per-load',
    canSetTtl: true,
    configuredAtLaunch: false,
    reportsPerModelVram: true,
    managed: true,
    canSetCompute: true,
  },
};

export interface ResidentModel {
  id: string;
  sizeBytes?: number;
  vramBytes?: number;
  contextLength?: number;
  /**
   * Transformer layers the load put on the GPU, and the model's total, when
   * known. `gpuLayers === totalLayers` is a full offload.
   */
  gpuLayers?: number;
  totalLayers?: number;
  /**
   * Where it runs, in one token: `gpu` every layer offloaded, `cpu` none,
   * `gpu+cpu` split. Absent means the runtime cannot say.
   */
  loadedOn?: 'gpu' | 'gpu+cpu' | 'cpu';
  /** The settings it was loaded with. Nekko's own Model Server only. */
  params?: LoadParams;
  /** When it last served a request: the field LRU eviction reads. */
  lastUsedAt?: number;
  /** When it was loaded. */
  startedAt?: number;
  expiresAt?: number;
}

export interface RuntimeStatus {
  kind: RuntimeKind;
  running: boolean;
  /** A binary or CLI we could start it with was found on this machine. */
  installed?: boolean;
  /** Why it cannot be started, when `installed` is false. */
  reason?: string;
  /** We spawned this process and hold its handle. */
  owned: boolean;
  version?: string;
  baseUrl: string;
  startedAt?: number;
  resident: ResidentModel[];
  /** Last lines of captured output, so a failed start can explain itself. */
  log?: string[];
  error?: string;
  /** vLLM only: parsed /metrics highlights. */
  metrics?: RuntimeMetrics;
}

export interface RuntimeMetrics {
  kvCacheUsagePct?: number;
  requestsRunning?: number;
  requestsWaiting?: number;
}

/**
 * What a load is asked to do.
 *
 * The first four are the cross-runtime set every adapter understands. The rest
 * are llama.cpp flags, ignored by adapters whose runtime has no equivalent, which
 * is why they are optional rather than a separate parameter type: one load call
 * serves every runtime, and `canSetCompute` says whose controls to draw.
 */
export interface LoadParams {
  /** Local model reasoning. Default on; configurable only under Expert. */
  thinking?: boolean;
  contextTokens?: number;
  gpuLayers?: number;
  kvCacheDtype?: KvCacheDtype;
  ttlSeconds?: number;

  /** Concurrent request slots. Each one gets its own full KV cache. */
  parallelSlots?: number;
  /** Logical batch size (`--batch-size`). */
  batchSize?: number;
  /** Physical batch size (`--ubatch-size`). */
  ubatchSize?: number;
  /** CPU threads for generation. Absent means let the engine choose. */
  threads?: number;
  /** Flash attention, which cuts attention memory where the build supports it. */
  flashAttention?: boolean;
  /** Memory-map the weights instead of reading them in. Default on. */
  mmap?: boolean;
  /** Lock the weights in RAM so the OS cannot page them out. */
  mlock?: boolean;
  /** RoPE overrides, for running a model past its trained context. */
  ropeFreqBase?: number;
  ropeFreqScale?: number;
  /** Sampling seed. Absent means random. */
  seed?: number;
  diffusion?: import('./engine.js').EngineLoadPreset['diffusion'];
  /**
   * Speculative decoding. On unless set false: n-gram lookup from the
   * conversation itself (llama.cpp's `--spec-default`), which needs no second
   * model and is what makes edits that repeat their input several times
   * faster. Works with a vision projector loaded too.
   */
  speculative?: boolean;
  /**
   * Library id of a small same-family model to draft with as well. Opt-in:
   * measured, a draft that is too large relative to its target slows ordinary
   * replies down even while it speeds edits up.
   */
  draftModelId?: string;
  /** The first N layers keep their experts in RAM (`--n-cpu-moe`); all of them is `--cpu-moe`. */
  cpuMoeLayers?: number;
  /** The first N layers run their feed-forward from RAM (`--n-cpu-ffn`), for dense models. */
  cpuFfnLayers?: number;
  /** Spare VRAM for llama.cpp's cache of the busiest CPU-resident experts. */
  moeCacheMiB?: number;
  /** False keeps the KV cache in system RAM (`--no-kv-offload`). */
  kvOnGpu?: boolean;
  /** Page lookup tables (n-gram embeddings) from the file (`--lazy-mode`). */
  lazyTables?: boolean;
  /** Threads for reading prompts (`--threads-batch`). */
  threadsBatch?: number;
}

export interface StartOptions {
  baseUrl: string;
  /** Env applied to the spawned process (OLLAMA_NUM_PARALLEL and friends). */
  env?: Record<string, string>;
}

export interface StopResult {
  ok: boolean;
  message: string;
  /** We refused because the process is not ours. Retry with force to proceed. */
  needsConfirmation?: boolean;
  /** What we would be killing, so the confirmation can name it. */
  processName?: string;
}

export interface LoadResult {
  ok: boolean;
  message?: string;
  facts?: ModelFacts;
}

/** Environment variables that only take effect when the server restarts. */
export const RUNTIME_ENV_HINTS: Partial<Record<RuntimeKind, Record<string, string>>> = {
  ollama: {
    parallel: 'OLLAMA_NUM_PARALLEL',
    kvCacheType: 'OLLAMA_KV_CACHE_TYPE',
    maxLoaded: 'OLLAMA_MAX_LOADED_MODELS',
  },
};
