import type {
  EngineLoadPreset,
  KvCacheDtype,
  LoadParams,
  LocalModel,
  PlacementPlan,
  PlacementRequest,
  Recommendation,
  SplitPreset,
} from '@nekko-agent/shared';

/**
 * The load drawer's state is one `LoadParams`, the shape the engine launches
 * with. Everything the drawer shows (where it runs, context per session, the
 * three simple sliders) is read off it here, and every control writes back
 * through here, so the meter, the saved preset and the launch never disagree.
 */

export type RunOn = 'gpu' | 'hybrid' | 'cpu';

export const SESSION_STOPS = [1, 2, 3, 4, 6, 8];
export const PRECISIONS: Array<{ dtype: KvCacheDtype; label: string }> = [
  { dtype: 'f16', label: 'Most reliable' },
  { dtype: 'q8_0', label: 'Balanced' },
  { dtype: 'q4_0', label: 'Fastest' },
];
export const KEEP_LABELS = ['Load when needed', 'Keep loaded', 'Pin in memory'];
const CONTEXT_STOPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const MIB = 1024 * 1024;

export const isMoe = (m: Pick<LocalModel, 'weightLayout'>) => (m.weightLayout?.expertShare ?? 0) > 0;
export const hasTables = (m: Pick<LocalModel, 'weightLayout'>) => (m.weightLayout?.tableShare ?? 0) > 0;

/** Context stops this model can be asked for, its own maximum last. */
export function contextStops(maxContext?: number): number[] {
  const max = maxContext ?? 131072;
  const stops = CONTEXT_STOPS.filter((s) => s <= max);
  if (stops.at(-1) !== max) stops.push(max);
  return stops;
}

export function sessionsOf(p: LoadParams): number {
  return Math.max(1, p.parallelSlots ?? 1);
}

/** `contextTokens` is the whole pool (`--ctx-size`); the drawer shows each session's share. */
export function contextPerSession(p: LoadParams): number {
  return Math.floor((p.contextTokens ?? 8192) / sessionsOf(p));
}

export function runOnOf(p: LoadParams, layers?: number): RunOn {
  if (p.gpuLayers === 0) return 'cpu';
  const split =
    (p.gpuLayers !== undefined && layers !== undefined && p.gpuLayers < layers) ||
    (p.cpuMoeLayers ?? 0) > 0 ||
    (p.cpuFfnLayers ?? 0) > 0 ||
    p.kvOnGpu === false;
  return split ? 'hybrid' : 'gpu';
}

export function keepOf(p: LoadParams): number {
  if (p.mlock) return 2;
  return p.ttlSeconds === 0 ? 1 : 0;
}

export function keepParams(level: number): Partial<LoadParams> {
  return level === 0 ? { ttlSeconds: undefined, mlock: false } : { ttlSeconds: 0, mlock: level === 2 };
}

export function precisionOf(p: LoadParams): number {
  return Math.max(0, PRECISIONS.findIndex((x) => x.dtype === (p.kvCacheDtype ?? 'f16')));
}

/** The planner's question for these parameters. */
export function toPlacementRequest(p: LoadParams, model: Pick<LocalModel, 'layers' | 'weightLayout'>): PlacementRequest {
  const layers = model.layers ?? 1;
  const runOn = runOnOf(p, model.layers);
  return {
    runOn,
    contextTokens: contextPerSession(p),
    sessions: sessionsOf(p),
    kvCacheDtype: p.kvCacheDtype ?? 'f16',
    gpuLayers: runOn === 'cpu' ? 0 : (p.gpuLayers ?? layers),
    cpuMoeLayers: p.cpuMoeLayers ?? 0,
    cpuFfnLayers: p.cpuFfnLayers ?? 0,
    kvOnGpu: p.kvOnGpu !== false,
    mmap: p.mmap !== false,
    pin: p.mlock ?? false,
    tablesOnDisk: p.lazyTables !== false,
    moeCacheBytes: (p.moeCacheMiB ?? 0) * MIB,
  };
}

/** A solved request as launch parameters, keeping the fields it does not decide. */
export function fromRecommendation(
  rec: Recommendation['request'],
  model: Pick<LocalModel, 'layers' | 'weightLayout'>,
  keep: LoadParams = {},
): LoadParams {
  const layers = model.layers ?? 1;
  return {
    ...keep,
    contextTokens: rec.contextTokens * rec.sessions,
    parallelSlots: rec.sessions > 1 ? rec.sessions : undefined,
    kvCacheDtype: rec.kvCacheDtype,
    gpuLayers: rec.runOn === 'cpu' ? 0 : rec.runOn === 'gpu' ? layers : rec.gpuLayers,
    cpuMoeLayers: rec.runOn === 'hybrid' && rec.cpuMoeLayers > 0 ? rec.cpuMoeLayers : undefined,
    cpuFfnLayers: rec.runOn === 'hybrid' && rec.cpuFfnLayers > 0 ? rec.cpuFfnLayers : undefined,
    kvOnGpu: rec.kvOnGpu ? undefined : false,
    lazyTables: hasTables(model) ? true : keep.lazyTables,
    moeCacheMiB: undefined,
    ...(keep.ttlSeconds === undefined && !keep.mlock ? keepParams(1) : {}),
  };
}

/** Parameters with the drawer-only fields of a saved preset stripped. */
export function fromPreset(preset?: EngineLoadPreset): { params: LoadParams; split: SplitPreset } {
  if (!preset) return { params: {}, split: 'custom' };
  const { budgetFraction: _b, splitPreset, ...params } = preset;
  return { params, split: splitPreset ?? 'custom' };
}

/**
 * Whether the drawer's settings differ from the saved ones, which every load
 * the drawer does not start (from chat, at engine start) uses. An unset field
 * and a missing one are the same setting.
 */
export function differsFromSaved(params: LoadParams, saved: LoadParams): boolean {
  const set = (p: LoadParams) =>
    Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(set(params)) !== JSON.stringify(set(saved));
}

/** The settings a reload restarts the model for: `same_params` in `crates/nekko-engine/src/server.rs`. */
const RELOAD_KEYS = [
  'contextTokens',
  'gpuLayers',
  'kvCacheDtype',
  'parallelSlots',
  'batchSize',
  'ubatchSize',
  'threads',
  'flashAttention',
  'mmap',
  'mlock',
  'ropeFreqBase',
  'ropeFreqScale',
  'seed',
  'speculative',
  'draftModelId',
  'cpuMoeLayers',
  'cpuFfnLayers',
  'moeCacheMiB',
  'kvOnGpu',
  'lazyTables',
  'threadsBatch',
] as const;

/**
 * Whether the running copy of a model was loaded with different settings than
 * these, so Reload would restart it. Mirrors the engine's own test: an unset
 * field and a missing one are the same, null is not.
 */
export function differsFromLoaded(params: LoadParams, loaded: LoadParams): boolean {
  const field = (p: LoadParams, k: (typeof RELOAD_KEYS)[number]) => (p as Record<string, unknown>)[k];
  const diffusion = (p: LoadParams) => JSON.stringify(p.diffusion ?? {});
  return RELOAD_KEYS.some((k) => field(params, k) !== field(loaded, k)) || diffusion(params) !== diffusion(loaded);
}

/** Which settings still match the recommendation, for the "Recommended" tags. */
export function matchesRecommendation(p: LoadParams, rec: Recommendation['request'] | undefined, layers?: number) {
  if (!rec) return { runOn: false, context: false, sessions: false, precision: false };
  return {
    runOn: runOnOf(p, layers) === rec.runOn,
    context: contextPerSession(p) === rec.contextTokens,
    sessions: sessionsOf(p) === rec.sessions,
    precision: (p.kvCacheDtype ?? 'f16') === rec.kvCacheDtype,
  };
}

/** Spare VRAM worth giving the expert cache: about a tenth of the experts. */
export function expertCacheMiB(plan: PlacementPlan, model: Pick<LocalModel, 'weightLayout' | 'sizeBytes'>): number | undefined {
  const experts = (model.weightLayout?.expertShare ?? 0) * model.sizeBytes;
  const mib = Math.floor(Math.min(experts * 0.1, plan.spareVramBytes) / MIB);
  return mib >= 256 ? mib : undefined;
}

/** "about 390 pages": 1K tokens is roughly 750 words, a page and a half. */
export function pagesOf(tokens: number): number {
  return Math.round((tokens / 1000) * 1.5);
}
