/**
 * Fit-planning types: what we know about a model, what the machine has, and the
 * projection that answers "will this fit, where will it run, and why".
 *
 * The math lives in the engine (crates/nekko-engine/src/capacity.rs). These are
 * the contracts that travel between it, what gathers the facts, and the renderer
 * that draws the result.
 *
 * Every optional field is optional on purpose. A missing field means the planner
 * answers `unknown` rather than inventing a number, which matters more here than
 * anywhere else in the app: a confident wrong VRAM figure costs the user a long
 * load and their trust in every figure after it.
 */

/** KV-cache element type. Halving the element halves the cache. */
export type KvCacheDtype = 'f16' | 'q8_0' | 'q4_0' | 'fp8';

export function kvBytesPerElement(dtype: KvCacheDtype): number {
  switch (dtype) {
    case 'f16':
      return 2;
    case 'q8_0':
      return 1;
    case 'fp8':
      return 1;
    case 'q4_0':
      return 0.5;
  }
}

/** What we know about a model, normalized across runtimes. */
export interface ModelFacts {
  id: string;
  providerId: string;
  /** Weights on disk / as loaded. The honest number, never paramCount x bits. */
  weightsBytes?: number;
  /** Transformer block count. */
  layers?: number;
  /** KV head count. Grouped-query models have fewer of these than attention heads. */
  kvHeads?: number;
  /** Per-head dimension, embeddingLength / attentionHeadCount. */
  headDim?: number;
  /** The model's own maximum context. */
  maxContext?: number;
  /** e.g. "Q4_K_M", "fp8". Display only, never used to infer size. */
  quantization?: string;
  /** e.g. "8B". Display only. */
  parameterSize?: string;
  /** Currently resident in memory. */
  loaded?: boolean;
  /** Measured VRAM while resident, when the runtime reports it. */
  vramBytes?: number;
  /** Context it was actually loaded with. */
  loadedContext?: number;
}

/** One memory pool the planner can place a model in. */
export interface CapacityDevice {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

export interface HardwareFacts {
  devices: CapacityDevice[];
  /**
   * GPU and CPU share one pool (Apple Silicon). Never add system RAM on top of a
   * unified device: doing so makes a 36 GB Mac look like it has 72 GB.
   */
  unified: boolean;
  systemRamTotalBytes: number;
  systemRamFreeBytes: number;
}

export interface FitRequest {
  contextTokens: number;
  parallelSlots: number;
  kvCacheDtype: KvCacheDtype;
  /** 0..1 share of layers placed on the GPU. 1 means all of them. */
  gpuLayerFraction: number;
}

export const DEFAULT_FIT_REQUEST: FitRequest = {
  contextTokens: 8192,
  parallelSlots: 1,
  kvCacheDtype: 'f16',
  gpuLayerFraction: 1,
};

export type FitVerdict = 'fits' | 'tight' | 'spills' | 'wont-load' | 'unknown';

export type FitReasonCode =
  | 'missing-metadata'
  | 'context-over-max'
  | 'kv-cache-dominates'
  | 'weights-exceed-device'
  | 'exceeds-total-memory'
  | 'headroom-thin'
  | 'unified-memory'
  | 'multi-device-not-pooled'
  | 'no-gpu'
  | 'partial-offload';

/**
 * A structured reason. The UI writes the sentence; we supply the numbers, so the
 * wording can change without touching the planner and the numbers can't drift
 * from the prose describing them.
 */
export interface FitReason {
  code: FitReasonCode;
  /** Bytes the reason is about, when it is about bytes. */
  bytes?: number;
  /** Share of the budget, 0-100. */
  sharePct?: number;
  /** Detail for codes that need one (a device name, a missing field name). */
  detail?: string;
}

/** A one-click fix. `apply` is a partial FitRequest to merge into the current one. */
export interface FitSuggestion {
  label: string;
  savesBytes?: number;
  apply?: Partial<FitRequest>;
  /** Suggests loading a different model id instead (usually a smaller quant). */
  alternateModelId?: string;
}

export interface FitPlan {
  verdict: FitVerdict;
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  requiredBytes: number;
  /** The device the plan is measured against; null when there is no GPU. */
  deviceName: string | null;
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  /** Estimated layers resident on the GPU, and the model's total. */
  gpuLayers?: number;
  totalLayers?: number;
  /** Bytes expected to land in system RAM instead of VRAM. */
  spillBytes: number;
  reasons: FitReason[];
  suggestions: FitSuggestion[];
}

/**
 * The simple surface's answer.
 *
 * `request` is what to load with, `plan` is the projection those settings
 * produce, and the two sentences are what the user reads instead of the numbers.
 * The prose deliberately names memory rather than tokens per second: we can
 * measure the first and would be inventing the second.
 */
export interface AutoFitSummary {
  request: FitRequest;
  plan: FitPlan;
  /** One sentence naming what was chosen. */
  headline: string;
  /** One sentence naming what it costs, in memory left over. */
  tradeoff: string;
  /** Why not something larger, when something had to be given up. */
  compromises: string[];
}

/** Measured residency after a load, kept beside the projection that predicted it. */
export interface FitMeasurement {
  at: number;
  modelId: string;
  totalBytes: number;
  vramBytes: number;
  /** Measured minus projected. Positive means we under-estimated. */
  deltaBytes: number;
}
