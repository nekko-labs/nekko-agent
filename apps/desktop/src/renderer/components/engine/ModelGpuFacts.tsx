import { useEffect, useState } from 'react';
import { DEFAULT_FIT_REQUEST, type FitPlan, type LocalModel, type ResidentModel } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';

/**
 * What one model on disk needs on this machine's GPU, and what is left for
 * context: its weights, what each thousand tokens of context costs, and the
 * longest context that fits beside whatever else is loaded right now.
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

export function ModelGpuFacts({ providerId, model, resident }: { providerId: string; model: LocalModel; resident?: ResidentModel }) {
  const [plan, setPlan] = useState<FitPlan | null>(null);
  const maxCtx = model.maxContext ?? 0;
  useEffect(() => {
    setPlan(null);
    if (!maxCtx || model.modality === 'image') return;
    let live = true;
    window.nekko
      .runtimePlan(providerId, model.id, { ...DEFAULT_FIT_REQUEST, contextTokens: maxCtx, gpuLayerFraction: 1 })
      .then((p) => { if (live) setPlan(p); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [providerId, model.id, maxCtx, model.modality]);

  // No GPU, no geometry, or an answer the planner itself would not give: say nothing.
  if (!plan || plan.verdict === 'unknown' || !plan.deviceName || !maxCtx) return null;
  const free = plan.deviceFreeBytes + ownGpuBytes(resident);
  const fits = contextThatFits(plan, free, maxCtx);
  if (fits === null) return null;
  const perThousand = (plan.kvCacheBytes / maxCtx) * 1024;
  const facts: Array<[string, string, string?]> = [
    ['Weights', formatBytes(plan.weightsBytes)],
    ['Context per 1k tokens', formatBytes(perThousand), 'The KV cache this model keeps for every thousand tokens of conversation, at its default precision'],
    ['Context that fits now', fits >= maxCtx ? `All ${formatTokens(maxCtx)}` : `${formatTokens(fits)} of ${formatTokens(maxCtx)}`, 'Beside the other models loaded right now, with every layer on the GPU'],
    ['Free on the GPU', `${formatBytes(free)} of ${formatBytes(plan.deviceTotalBytes)}`],
  ];
  return (
    <div className="mt-(--q-group)" data-model-gpu-facts>
      <h4 className="quiet-group-label">On {plan.deviceName}</h4>
      <dl className="mt-(--q-heading) flex flex-wrap gap-x-8 gap-y-2">
        {facts.map(([label, value, title]) => (
          <div key={label} title={title}>
            <dt className="text-xs text-ink-faint">{label}</dt>
            <dd className={`mt-(--q-tight) text-sm font-medium tabular-nums ${label === 'Context that fits now' && fits === 0 ? 'text-warning-text' : ''}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
