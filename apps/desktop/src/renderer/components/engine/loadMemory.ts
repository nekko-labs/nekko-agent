import type { LoadParams, LocalModel, PlacementPlan } from '@nekko-agent/shared';
import { breakdown, sumRam, sumVram } from './memoryBreakdown.js';
import { contextPerSession, sessionsOf } from './loadSettings.js';

export type LoadMemoryModel = Pick<LocalModel, 'sizeBytes' | 'layers' | 'format' | 'modality' | 'maxContext' | 'mlxKvBytesPerToken'>;

/** Refresh until the effect closes, without overlapping reads or publishing old results. */
export function pollLoadMemory<T>(read: () => Promise<T>, publish: (value: T) => void, intervalMs: number, firstDelayMs = 0) {
  let closed = false;
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const value = await read();
      if (!closed) publish(value);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void poll(), firstDelayMs);
  const interval = setInterval(() => void poll(), intervalMs);
  return () => {
    closed = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}

/** Keep disk size separate from projected memory. Missing terms are not zero bytes. */
export function loadMemoryEstimate(plan: PlacementPlan | null, params: LoadParams, model: LoadMemoryModel) {
  const image = model.modality === 'image';
  const mlx = model.format === 'mlx';
  const text = !image && model.modality !== 'embedding' && model.modality !== 'audio';
  const context = text ? { perSession: contextPerSession(params), sessions: sessionsOf(params) } : null;
  const rate = model.mlxKvBytesPerToken;
  const max = model.maxContext;
  // MLX grows its cache as tokens are used. This is the payload at the
  // selected length, not preallocated memory or total runtime memory.
  const mlxContext = mlx && context && rate && max && context.perSession > 0 && context.perSession <= max
    && Number.isSafeInteger(rate * max * context.sessions) && rate > 0
    ? { bytes: rate * context.perSession * context.sessions, scaleBytes: rate * max * context.sessions }
    : null;
  const valid = !image && !mlx && plan !== null && plan.verdict !== 'unknown' && plan.reason !== 'context-over-max';
  // An older planner returns zero for all parts on missing metadata. A newer
  // one can return the parts it does know; do not throw those bytes away.
  const parts = image || mlx || !plan ? [] : breakdown(plan, valid ? params : { ...params, moeCacheMiB: undefined }, model.layers);
  const vramBytes = sumVram(parts);
  const ramBytes = sumRam(parts);
  const projectedBytes = vramBytes + ramBytes;
  const totalBytes = valid && Number.isFinite(projectedBytes) && projectedBytes > 0 ? projectedBytes : null;
  const fileBytes = Number.isFinite(model.sizeBytes) && model.sizeBytes > 0 ? model.sizeBytes : null;
  const unknownParts = totalBytes !== null ? [] : image
    ? ['Image weights in memory', 'Supporting files in memory', 'Working space']
    : [
        ...(!parts.some((p) => p.aspect === 'weights') ? ['Model weights in memory'] : []),
        ...(text && !mlxContext && !parts.some((p) => p.aspect === 'context') ? ['Context memory'] : []),
        ...(!parts.some((p) => p.aspect === 'working') ? ['Working space'] : []),
      ];
  return { totalBytes, vramBytes, ramBytes, parts, fileBytes, context, mlxContext, unknownParts };
}
