import { useEffect, useState } from 'react';
import type { LoadParams, LocalModel, PlacementPlan } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { ASPECT_COLOR, MemoryBar, Swatch } from './MemoryBar.js';
import { loadMemoryEstimate, pollLoadMemory, type LoadMemoryModel } from './loadMemory.js';
import type { Aspect, AspectPart } from './memoryBreakdown.js';
import { toPlacementRequest } from './loadSettings.js';

const PLAN_DEBOUNCE_MS = 150;
const PLAN_REFRESH_MS = 5000;

/** Replan for edits and changes in headroom. Never present an old request as the current configuration. */
export function useLoadPlacement(providerId: string, model: Pick<LocalModel, 'id' | 'layers' | 'format'>, params: LoadParams) {
  const { id, layers } = model;
  const mlx = model.format === 'mlx';
  const [answer, setAnswer] = useState<{ params: LoadParams; modelId: string; providerId: string; layers?: number; plan: PlacementPlan | null }>();
  useEffect(() => mlx ? undefined : pollLoadMemory(
    async () => window.nekko.runtimePlace(providerId, id, toPlacementRequest(params, { layers })).catch(() => null),
    (plan) => setAnswer({ params, modelId: id, providerId, layers, plan }),
    PLAN_REFRESH_MS,
    PLAN_DEBOUNCE_MS,
  ), [mlx, providerId, id, layers, params]);
  const sameModel = !mlx && answer?.modelId === id && answer.providerId === providerId;
  const current = sameModel && answer.params === params && answer.layers === layers;
  const previous = sameModel && answer.layers === layers ? answer : null;
  return { plan: current ? answer.plan : null, hardware: previous?.plan ?? null, previous, pending: !mlx && !current };
}

const EMPTY_PARAMS: LoadParams = {};
const bytesIn = (part: AspectPart, key: 'vram' | 'ram') => key === 'vram' ? part.vramBytes : part.ramBytes;

export function LoadMemoryMeter({ model, plan = null, params = EMPTY_PARAMS, pending = false, previous }: {
  model: LoadMemoryModel;
  plan?: PlacementPlan | null;
  params?: LoadParams;
  pending?: boolean;
  previous?: { plan: PlacementPlan | null; params: LoadParams } | null;
}) {
  const [hover, setHover] = useState<Aspect | null>(null);
  const image = model.modality === 'image';
  const estimate = loadMemoryEstimate(plan, params, model);
  const { totalBytes, context, mlxContext, unknownParts } = estimate;
  const prior = pending && !plan && previous?.plan ? previous : null;
  const graphPlan = prior?.plan ?? plan;
  const { parts, fileBytes } = prior ? loadMemoryEstimate(graphPlan, prior.params, model) : estimate;
  const unified = graphPlan?.unified ?? false;
  const pools = !graphPlan ? [] : ([
    { key: 'vram', label: unified ? 'Unified memory' : 'VRAM', pool: graphPlan.vram },
    { key: 'ram', label: 'RAM', pool: graphPlan.ram },
  ] as const).filter(({ key }) => parts.some((part) => bytesIn(part, key) > 0));
  const diskOnly = totalBytes === null && fileBytes !== null && !parts.some((part) => part.aspect === 'weights');
  const fileLabel = image ? 'Image model weights' : 'Model weights';
  return (
    <section aria-label="Memory" className="mt-(--q-group) space-y-2" data-meter onMouseLeave={() => setHover(null)}>
      <div className="space-y-2" data-meter-configuration>
        <h4 className="text-xs font-medium">Configuration memory</h4>
        {prior && pools.length > 0 && <p className="text-xs text-ink-faint">Updating… showing the previous estimate.</p>}
        {pools.map(({ key, label, pool }) => {
          const own = parts.reduce((n, part) => n + bytesIn(part, key), 0);
          const over = plan?.verdict === 'wont-load' && own > pool.availBytes;
          return <div key={key} className="space-y-1" data-meter-bar={key}>
            <p className="flex flex-wrap justify-between gap-x-2 text-xs text-ink-soft">
              <span>{label}</span>{pool.totalBytes > 0 && <span>{formatBytes(pool.totalBytes)} capacity</span>}
            </p>
            <MemoryBar segments={parts.map((part) => ({ key: part.aspect, bytes: bytesIn(part, key), color: ASPECT_COLOR[part.aspect],
              title: `${part.label} ${formatBytes(bytesIn(part, key))}: ${part.driver}`, slices: part.slices,
              dim: hover !== null && hover !== part.aspect, onHover: (on) => setHover(on ? part.aspect : null) }))}
              scaleBytes={Math.max(pool.totalBytes, own)} label={prior ? `${label}, previous estimate while updating` : `${label} for this configuration`} over={over} />
          </div>;
        })}
        {diskOnly && <div className="space-y-1" data-meter-bar="disk">
          <p className="flex flex-wrap justify-between gap-x-2 text-xs text-ink-soft">
            <span>{fileLabel} on disk</span><span>{formatBytes(fileBytes)}</span>
          </p>
          <MemoryBar segments={[{ key: 'weights', bytes: fileBytes, color: ASPECT_COLOR.weights, title: `${fileLabel}: ${formatBytes(fileBytes)} on disk` }]}
            scaleBytes={fileBytes} label={`${fileLabel} on disk, not a RAM estimate`} />
        </div>}
        {mlxContext && <div className="space-y-1" data-meter-bar="mlx-context">
          <p className="flex flex-wrap justify-between gap-x-2 text-xs text-ink-soft">
            <span>Context cache at selected length</span><span>≈ {formatBytes(mlxContext.bytes)}</span>
          </p>
          <MemoryBar segments={[{ key: 'context', bytes: mlxContext.bytes, color: ASPECT_COLOR.context, title: 'Estimated cache when filled to the selected length' }]}
            scaleBytes={mlxContext.scaleBytes} label="Estimated context cache relative to the model maximum" />
        </div>}
        {!pools.length && !diskOnly && !mlxContext && <p className="text-xs text-ink-faint">No sizes available to graph.</p>}
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs" data-meter-total>
          <span className="font-medium">Configuration total</span>
          <span className="font-mono text-ink-soft">{totalBytes !== null ? `≈ ${formatBytes(totalBytes)}` : pending ? 'Calculating…' : 'Unknown'}</span>
        </div>
      </div>
      {totalBytes === null && <>
        {context && <p className="text-xs text-ink-soft" data-meter-context>
          Selected context: {formatTokens(context.perSession)} tokens per session{context.sessions > 1 ? ` × ${context.sessions} sessions` : ''}
        </p>}
        {!pending && <p className="text-xs text-ink-faint" data-meter-partial>{image
          ? 'Partial breakdown. Memory depends on the supporting files, offload settings, and image size.'
          : plan?.reason === 'context-over-max' ? 'That is more context than this model supports.'
          : mlxContext ? 'Partial breakdown. The context cache grows as tokens are used; the track ends at the model maximum.'
          : 'Partial breakdown. There is not enough information to estimate the full load.'}</p>}
        {!pending && unknownParts.length > 0 && <dl className="space-y-0.5 text-xs text-ink-faint">
          {unknownParts.map((label) => <div key={label} className="flex justify-between gap-x-2"><dt>{label}</dt><dd>Unknown</dd></div>)}
        </dl>}
      </>}
      {parts.length > 0 && <table className="w-full text-xs" data-meter-breakdown>
        <thead>
          <tr className="text-2xs text-ink-faint">
            <th className="pb-1 text-left font-normal">What uses it</th>
            {pools.map(({ key, label }) => <th key={key} className="w-20 pb-1 text-right font-normal">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {parts.map((part) => (
            <tr key={part.aspect} className="align-baseline transition-opacity duration-(--dur-fast)"
              style={{ opacity: hover !== null && hover !== part.aspect ? 0.45 : 1 }}
              onMouseEnter={() => setHover(part.aspect)} onMouseLeave={() => setHover(null)} data-meter-part={part.aspect}>
              <td className="py-0.5 pr-2">
                <span className="inline-flex items-baseline gap-2">
                  <span className="self-center"><Swatch color={ASPECT_COLOR[part.aspect]} /></span>
                  <span><span className="font-medium">{part.label}</span><span className="ml-2 text-ink-faint">{part.driver}</span></span>
                </span>
              </td>
              {pools.map(({ key }) => <td key={key} className="py-0.5 text-right font-mono text-2xs text-ink-faint">
                {bytesIn(part, key) > 0 ? formatBytes(bytesIn(part, key)) : '–'}
              </td>)}
            </tr>
          ))}
        </tbody>
      </table>}
      {!image && plan && (plan.disk.tableBytes > 0 || plan.disk.overflowBytes > 0) && (
        <p className="text-xs text-warning-text" data-meter-disk>
          {plan.disk.tableBytes > 0 && `Its lookup table (${formatBytes(plan.disk.tableBytes)}) stays on your SSD. `}
          {plan.disk.overflowBytes > 0 && `Reads about ${formatBytes(plan.disk.overflowBytes)} of the model from your SSD as needed.`}
        </p>
      )}
      {!image && plan?.verdict === 'wont-load' && plan.reason !== 'context-over-max' && plan.shortByBytes != null && (
        <p className="text-xs text-danger-text">This won’t load as set: short by {formatBytes(plan.shortByBytes)} of {plan.reason === 'ram' ? 'RAM' : unified ? 'unified memory' : 'VRAM'}.</p>
      )}
    </section>
  );
}
