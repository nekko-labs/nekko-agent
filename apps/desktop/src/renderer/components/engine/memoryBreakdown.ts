import type { GpuStats, LoadParams, PlacementPlan, SystemStats } from '@nekko-agent/shared';
import { ENGINE_KV_CACHE_DTYPE } from '@nekko-agent/shared';
import { formatTokens } from '../runtimes/verdict.js';
import { PRECISIONS, contextPerSession, runOnOf, sessionsOf } from './loadSettings.js';

/**
 * What a model's memory is for, and how much of each part sits in graphics
 * memory and in system memory.
 *
 * Both memory bars read from here: the load drawer's (one model, the settings
 * on screen) and Loaded models' live bar (every model in memory, the settings
 * each was loaded with). The bytes are the placement planner's; this file only
 * names each part by the setting that drives it ("4 sessions x 32k" rather
 * than "KV cache"), so a person can see which knob to turn.
 */

const MIB = 1024 * 1024;

export type Aspect = 'weights' | 'experts' | 'context' | 'working' | 'pinned' | 'model';

export interface AspectPart {
  aspect: Aspect;
  label: string;
  /** The setting behind the number, in words. */
  driver: string;
  vramBytes: number;
  ramBytes: number;
  /** Context only: one slice per parallel session, which share the pool equally. */
  slices?: number;
}

export const ASPECT_ORDER: Aspect[] = ['weights', 'experts', 'context', 'working', 'pinned', 'model'];

/** How the weights get into memory. */
export function weightsLoading(params: LoadParams): string {
  if (params.mlock) return 'pinned, never paged out';
  if (params.mmap === false) return 'read into memory';
  return 'mapped from the file';
}

/** Where the layers run, in words. */
export function weightsPlace(plan: PlacementPlan, params: LoadParams, layers?: number): string {
  if (plan.unified) return 'on the GPU';
  if (!plan.deviceName) return 'on the processor';
  const runOn = runOnOf(params, layers);
  if (runOn === 'cpu') return 'on the processor';
  if (runOn === 'gpu') return layers ? `all ${layers} layers on the GPU` : 'all on the GPU';
  const g = Math.min(params.gpuLayers ?? layers ?? 0, layers ?? Infinity);
  const parts: string[] = [];
  if (layers && g < layers) parts.push(`${g} of ${layers} layers on the GPU`);
  if ((params.cpuMoeLayers ?? 0) > 0) parts.push(`experts of ${params.cpuMoeLayers} layers in RAM`);
  if ((params.cpuFfnLayers ?? 0) > 0) parts.push(`feed-forward of ${params.cpuFfnLayers} layers in RAM`);
  return parts.length ? parts.join(', ') : 'split between GPU and RAM';
}

export function contextDriver(params: LoadParams): string {
  const n = sessionsOf(params);
  const per = formatTokens(contextPerSession(params));
  const dtype = params.kvCacheDtype ?? ENGINE_KV_CACHE_DTYPE;
  const precision = PRECISIONS.find((p) => p.dtype === dtype)?.label.toLowerCase() ?? dtype;
  const where = params.kvOnGpu === false ? ', kept in RAM' : '';
  return `${n === 1 ? `1 session of ${per}` : `${n} sessions × ${per}`}, ${precision} (${dtype})${where}`;
}

/**
 * The planner's answer as named parts. On a Mac the two pools are one, so
 * everything counts as graphics memory there (the drawer draws one bar).
 */
export function breakdown(plan: PlacementPlan, params: LoadParams, layers?: number): AspectPart[] {
  const v = plan.vram.model;
  const r = plan.ram.model;
  const fold = plan.unified;
  const cache = Math.min((params.moeCacheMiB ?? 0) * MIB, v.weightsBytes);
  const split = (vram: number, ram: number) => (fold ? { vramBytes: vram + ram, ramBytes: 0 } : { vramBytes: vram, ramBytes: ram });
  const sessions = sessionsOf(params);
  const parts: AspectPart[] = [
    {
      aspect: 'weights',
      label: 'Model weights',
      driver: `${weightsPlace(plan, params, layers)}, ${weightsLoading(params)}`,
      ...split(v.weightsBytes - cache, r.weightsBytes),
    },
    {
      aspect: 'experts',
      label: 'Expert cache',
      driver: 'spare graphics memory kept for the experts used most',
      ...split(cache, 0),
    },
    {
      aspect: 'context',
      label: 'Context',
      driver: contextDriver(params),
      ...split(v.kvCacheBytes, r.kvCacheBytes),
      slices: sessions > 1 ? sessions : undefined,
    },
    {
      aspect: 'working',
      label: 'Working space',
      driver: params.batchSize ? `compute buffers, batches of ${params.batchSize} tokens` : 'compute buffers for each step',
      ...split(v.overheadBytes, r.overheadBytes),
    },
    {
      aspect: 'pinned',
      label: 'Pinned copy',
      driver: 'Pin in memory holds the GPU’s layers in RAM a second time',
      ...split(0, r.pinnedBytes),
    },
  ];
  return parts.filter((p) => p.vramBytes > 0 || p.ramBytes > 0);
}

export const sumVram = (parts: AspectPart[]) => parts.reduce((n, p) => n + p.vramBytes, 0);
export const sumRam = (parts: AspectPart[]) => parts.reduce((n, p) => n + p.ramBytes, 0);

/* --------------------------------------------------------------- live bar */

/** One loaded model as the live bar sees it. */
export interface LiveModelInput {
  id: string;
  name: string;
  /** The planner's parts for how it was loaded; null when it cannot say. */
  parts: AspectPart[] | null;
  /** Graphics memory the engine measured the load taking. */
  measuredVramBytes?: number;
  /** What to show when there is no breakdown: the measured or file size. */
  fallbackBytes: number;
  loadedOn?: 'gpu' | 'gpu+cpu' | 'cpu';
}

export interface LiveLoadingInput {
  id: string;
  name: string;
  landedBytes: number;
  needBytes: number;
}

export interface LiveSlice {
  aspect: Aspect;
  bytes: number;
  slices?: number;
}

export interface LiveModelSegment {
  id: string;
  name: string;
  /** Series index, stable across both pools. */
  series: number;
  bytes: number;
  parts: LiveSlice[];
  /** Still streaming in: `bytes` is what has landed, `needBytes` what it will take. */
  loading?: { needBytes: number };
}

export interface LivePool {
  key: 'vram' | 'ram' | 'unified';
  title: string;
  totalBytes: number;
  otherBytes: number;
  models: LiveModelSegment[];
  freeBytes: number;
  /** The bar's full width: the pool, or more when the numbers run past it. */
  scaleBytes: number;
  /** Where overload protection starts refusing, as bytes from the left. */
  reserveAtBytes?: number;
}

const MB = 1024 * 1024;

/**
 * Lay every loaded model out on the machine's memory as it is right now.
 *
 * The live readings (used and total) come from the GPU and system probes;
 * each model's share comes from its breakdown. Where the engine measured a
 * load's graphics memory, that measurement wins and the planner only decides
 * how it splits into parts. Everything not ours is "other apps".
 */
export function livePools(input: {
  gpu: GpuStats | null;
  system: SystemStats | null;
  /** Apple Silicon: the GPU's memory is the machine's. */
  unified: boolean;
  models: LiveModelInput[];
  loading: LiveLoadingInput[];
  /** Overload protection's floor, or null when it is off. */
  reserveBytes: number | null;
}): LivePool[] {
  const { gpu, system, models, loading, reserveBytes } = input;
  const g = gpu && gpu.totalMB > 0 ? gpu : null;
  const hasGpu = g !== null;
  const unified = input.unified || !!gpu?.unified;
  const series = new Map<string, number>();
  [...models.map((m) => m.id), ...loading.map((l) => l.id)].forEach((id) => {
    if (!series.has(id)) series.set(id, series.size);
  });

  const perModel = models.map((m) => {
    let vram: LiveSlice[] = [];
    let ram: LiveSlice[] = [];
    if (m.parts && (sumVram(m.parts) > 0 || sumRam(m.parts) > 0)) {
      const planned = sumVram(m.parts);
      // Trust the measurement for the total, the planner for the split.
      const k = m.measuredVramBytes && planned > 0 ? m.measuredVramBytes / planned : 1;
      vram = m.parts.filter((p) => p.vramBytes > 0).map((p) => ({ aspect: p.aspect, bytes: p.vramBytes * k, slices: p.slices }));
      ram = m.parts.filter((p) => p.ramBytes > 0).map((p) => ({ aspect: p.aspect, bytes: p.ramBytes, slices: p.slices }));
    } else if (m.fallbackBytes > 0) {
      const slice = [{ aspect: 'model' as const, bytes: m.measuredVramBytes ?? m.fallbackBytes }];
      if (hasGpu && m.loadedOn !== 'cpu') vram = slice;
      else ram = slice;
    }
    return { m, vram, ram };
  });

  const seg = (id: string, name: string, parts: LiveSlice[]): LiveModelSegment => ({
    id,
    name,
    series: series.get(id) ?? 0,
    bytes: parts.reduce((n, p) => n + p.bytes, 0),
    parts,
  });
  const loadingSegs = loading.map((l) => ({
    ...seg(l.id, l.name, [{ aspect: 'model' as const, bytes: Math.max(0, l.landedBytes) }]),
    loading: { needBytes: l.needBytes },
  }));

  const pool = (
    key: LivePool['key'],
    title: string,
    totalBytes: number,
    usedBytes: number,
    segs: LiveModelSegment[],
    reserve: number | null,
  ): LivePool => {
    const modelSegs = segs.filter((s) => s.bytes > 0 || s.loading);
    const ours = modelSegs.reduce((n, s) => n + s.bytes, 0);
    const otherBytes = Math.max(0, usedBytes - ours);
    // A load still on its way shows what it will take, so room for it is visible.
    const pending = modelSegs.reduce((n, s) => n + (s.loading ? Math.max(0, s.loading.needBytes - s.bytes) : 0), 0);
    const scaleBytes = Math.max(1, totalBytes, otherBytes + ours + pending);
    return {
      key,
      title,
      totalBytes,
      otherBytes,
      models: modelSegs,
      freeBytes: Math.max(0, totalBytes - otherBytes - ours),
      scaleBytes,
      reserveAtBytes: reserve && totalBytes > reserve ? totalBytes - reserve : undefined,
    };
  };

  if (unified) {
    const total = g ? g.totalMB * MB : (system?.memTotalMB ?? 0) * MB;
    const used = g ? g.usedMB * MB : (system?.memUsedMB ?? 0) * MB;
    if (total <= 0) return [];
    const segs = perModel.map(({ m, vram, ram }) => seg(m.id, m.name, merge(vram, ram)));
    return [pool('unified', 'Memory (shared by GPU and CPU)', total, used, [...segs, ...loadingSegs], reserveBytes)];
  }

  const pools: LivePool[] = [];
  if (g) {
    pools.push(
      pool(
        'vram',
        'Graphics memory (VRAM)',
        g.totalMB * MB,
        g.usedMB * MB,
        [...perModel.map(({ m, vram }) => seg(m.id, m.name, vram)), ...loadingSegs],
        reserveBytes,
      ),
    );
  }
  if (system && system.memTotalMB > 0) {
    const ramSegs = perModel.map(({ m, ram }) => seg(m.id, m.name, ram));
    // Without a GPU every load lands in RAM.
    pools.push(pool('ram', 'System memory (RAM)', system.memTotalMB * MB, system.memUsedMB * MB, hasGpu ? ramSegs : [...ramSegs, ...loadingSegs], null));
  }
  return pools;
}

/** One model's parts in both pools as one list, same aspects added together. */
function merge(a: LiveSlice[], b: LiveSlice[]): LiveSlice[] {
  const out = new Map<Aspect, LiveSlice>();
  for (const p of [...a, ...b]) {
    const prev = out.get(p.aspect);
    out.set(p.aspect, prev ? { ...prev, bytes: prev.bytes + p.bytes } : { ...p });
  }
  return ASPECT_ORDER.flatMap((k) => (out.has(k) ? [out.get(k)!] : []));
}
