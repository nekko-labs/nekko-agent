import { useEffect, useState } from 'react';
import { DEFAULT_FIT_REQUEST, type FitPlan, type LocalModel, type ResidentModel } from '@nekko-agent/shared';
import { capacityBands, GpuCapacityBar } from './GpuCapacityBar.js';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';

/**
 * What one model on disk needs on this machine's GPU, and what is left for
 * context: what loading it takes, what each thousand tokens of context costs,
 * and the longest context that fits on a free GPU and beside whatever else
 * holds it right now. When the two differ, a line names who holds the rest.
 *
 * One plan answers all of it. It is asked for at the model's full context with
 * every layer on the GPU, so its KV figure is the per-token cost times that
 * context exactly; the free memory it measures is what is left beside the
 * other loaded models, plus this model's own share when it is the one loaded
 * (a reload frees it first).
 */

/** The longest context, at most `maxCtx`, that fits in `available` bytes beside the plan's weights and buffers. */
export function contextThatFits(plan: Pick<FitPlan, 'weightsBytes' | 'kvCacheBytes' | 'overheadBytes'>, available: number, maxCtx: number): number | null {
  if (plan.kvCacheBytes <= 0 || plan.weightsBytes <= 0 || maxCtx <= 0) return null;
  const room = available - plan.weightsBytes - plan.overheadBytes;
  if (room <= 0) return 0;
  const perToken = plan.kvCacheBytes / maxCtx;
  const fits = Math.floor(room / perToken);
  // Whole thousands, the way the context is read everywhere else.
  return Math.min(maxCtx, fits >= 1024 ? fits - (fits % 1024) : fits);
}

/** What this model holds on the GPU now, which a reload gives back. */
export function ownGpuBytes(resident: ResidentModel | undefined): number {
  if (!resident || resident.loadedOn === 'cpu') return 0;
  return resident.vramBytes ?? (resident.loadedOn === 'gpu' ? (resident.sizeBytes ?? 0) : 0);
}

/**
 * What Windows, the browser and the other apps keep on a GPU nobody is loading
 * models on. The planner reserves the same 2 GB of system RAM for the OS
 * (`OS_RESERVE_BYTES` in capacity.rs).
 */
// Keep equal to `DESKTOP_GPU_RESERVE_BYTES` in crates/nekko-engine/src/capacity.rs.
export const DESKTOP_RESERVE_BYTES = 2 * 1024 ** 3;

/** "All 256k", "196k of 256k" or "None": a context figure read against the model's longest. */
export function contextText(fits: number, maxCtx: number): string {
  if (fits >= maxCtx) return `All ${formatTokens(maxCtx)}`;
  if (fits <= 0) return 'None';
  return `${formatTokens(fits)} of ${formatTokens(maxCtx)}`;
}

/**
 * Who holds the GPU memory this model cannot have right now, in a sentence,
 * or null when nothing worth naming does (it fits now as well as it ever will).
 */
export function busyNote(usedBytes: number, others: string[], fitsNow: number, fitsFree: number): string | null {
  if (fitsNow >= fitsFree || usedBytes <= DESKTOP_RESERVE_BYTES) return null;
  const used = formatBytes(usedBytes);
  if (!others.length) return `Other apps hold ${used} of the GPU right now. Close them to give this model the room.`;
  const names = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return `${names} and other apps hold ${used} of the GPU right now. Unload ${others.length === 1 ? 'it' : 'them'} to give this model the room.`;
}

export function ModelGpuFacts({ providerId, model, resident, others = [] }: {
  providerId: string;
  model: LocalModel;
  resident?: ResidentModel;
  /** The names of the other models in memory now, which hold part of the GPU. */
  others?: string[];
}) {
  const [plan, setPlan] = useState<FitPlan | null>(null);
  const [recommended, setRecommended] = useState<number | null>(null);
  const maxCtx = model.maxContext ?? 0;
  useEffect(() => {
    setPlan(null);
    setRecommended(null);
    if (!maxCtx || model.modality === 'image') return;
    let live = true;
    window.nekko.runtimeRecommend(providerId, model.id, { goal: 'speed' })
      .then(r => { if (live && r && r.plan.verdict !== 'unknown') setRecommended(r.request.contextTokens); })
      .catch(() => undefined);
    window.nekko
      .runtimePlan(providerId, model.id, { ...DEFAULT_FIT_REQUEST, contextTokens: maxCtx, gpuLayerFraction: 1 })
      .then((p) => { if (live) setPlan(p); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [providerId, model.id, maxCtx, model.modality]);

  // No GPU, no geometry, or an answer the planner itself would not give: say nothing.
  if (!plan || plan.verdict === 'unknown' || !plan.deviceName || !maxCtx) return null;
  if (plan.deviceTotalBytes <= 0) return null;
  const free = Math.max(0, Math.min(plan.deviceTotalBytes, plan.deviceFreeBytes + ownGpuBytes(resident)));
  const fitsNow = contextThatFits(plan, free, maxCtx);
  const fitsFree = contextThatFits(plan, Math.max(0, plan.deviceTotalBytes - DESKTOP_RESERVE_BYTES), maxCtx);
  if (fitsNow === null || fitsFree === null) return null;
  const perThousand = (plan.kvCacheBytes / maxCtx) * 1024;
  const note = busyNote(plan.deviceTotalBytes - free, others, fitsNow, fitsFree);
  return (
    <section className="mt-(--q-group)" data-model-gpu-facts aria-label="GPU memory estimate">
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
        <h4 className="text-sm font-semibold">VRAM on {plan.deviceName}</h4>
        <span className="text-xs text-ink-soft tabular-nums">{formatBytes(free)} of {formatBytes(plan.deviceTotalBytes)} available</span>
      </div>
      <GpuCapacityBar bands={capacityBands(plan, free, maxCtx, recommended)} />
      <p className="mt-4 text-xs text-ink-soft"><strong className="font-medium text-ink">{fitsNow === 0 ? 'No context fits now.' : contextText(fitsNow, maxCtx) + ' tokens fit now.'}</strong>{' '}
        {fitsFree > fitsNow && <>{formatTokens(fitsFree)} fit on an idle GPU. </>}{formatBytes(perThousand)} per 1k tokens.
      </p>
      {note && <p className="mt-1 text-xs text-ink-soft" data-gpu-busy-note>{note}</p>}
    </section>
  );
}
