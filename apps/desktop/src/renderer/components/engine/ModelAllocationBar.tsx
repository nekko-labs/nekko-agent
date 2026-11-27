import type { EngineMemory, LoadParams, PlacementPlan } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { ASPECT_COLOR, MemoryBar, Swatch } from './MemoryBar.js';
import { loadMemoryEstimate, type LoadMemoryModel } from './loadMemory.js';

/** One track for the model's allocations. The dashed slot has no byte value. */
export function ModelAllocationBar({ model, params = {}, plan = null, previous, pending, memory }: {
  model: LoadMemoryModel;
  params?: LoadParams;
  plan?: PlacementPlan | null;
  previous?: { plan: PlacementPlan | null; params: LoadParams } | null;
  pending?: boolean;
  memory?: EngineMemory;
}) {
  const prior = pending && previous?.plan ? previous : null;
  const displayPlan = prior?.plan ?? plan;
  const estimate = loadMemoryEstimate(displayPlan, prior?.params ?? params, model);
  const { totalBytes, parts, context, mlxContext, unknownParts, fileBytes } = estimate;
  const unified = model.format === 'mlx' || displayPlan?.unified || memory?.kind === 'unified';
  const label = unified ? 'Unified memory' : estimate.vramBytes && estimate.ramBytes ? 'VRAM + RAM' :
    estimate.ramBytes || (!estimate.vramBytes && memory?.kind === 'ram') ? 'RAM' : 'VRAM';
  const graph = parts.map(part => ({
    key: part.aspect,
    bytes: part.vramBytes + part.ramBytes,
    color: ASPECT_COLOR[part.aspect],
    title: unified ? `${part.label} · ${part.driver}` : `${part.label} · ${[part.vramBytes && `${formatBytes(part.vramBytes)} VRAM`, part.ramBytes && `${formatBytes(part.ramBytes)} RAM`].filter(Boolean).join(' + ')}`,
    label: part.aspect === 'context' && context ? `Context (${context.sessions} ${context.sessions === 1 ? 'session' : 'sessions'} × ${formatTokens(context.perSession)})` : part.label,
    slices: part.slices,
  }));
  const segments = mlxContext
    ? [{ key: 'context', bytes: mlxContext.bytes, color: ASPECT_COLOR.context, title: 'Estimated cache when the selected context is full', label: 'Context cache' }]
    : graph;
  const unknown = totalBytes === null;
  const scale = Math.max(segments.reduce((sum, part) => sum + part.bytes, 0), mlxContext?.scaleBytes ?? 0,
    displayPlan ? (estimate.vramBytes ? displayPlan.vram.totalBytes : 0) + (estimate.ramBytes && !unified ? displayPlan.ram.totalBytes : 0) : memory?.budgetBytes ?? 0);
  const over = plan?.verdict === 'wont-load' && plan.reason !== 'context-over-max';
  return <section className="mt-1 space-y-1.5" aria-label="Memory breakdown" data-allocation-bar>
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
      <h4 className="font-medium">{label}</h4>
      <span className="text-2xs text-ink-soft" role="status">{pending ? (prior ? 'Updating estimate…' : 'Calculating…') : unknown ? 'Total unknown' : `≈ ${formatBytes(totalBytes)}`}</span>
    </div>
    <div className="flex gap-1">
      {segments.length > 0 && <div className="min-w-0 flex-1">
        <MemoryBar height="h-2.5" segments={segments} scaleBytes={scale} label={`${label} allocations${prior ? ', previous estimate while updating' : ''}`} over={over} />
      </div>}
      {unknown && <div className={`h-2.5 rounded border border-dashed border-ink-faint/70 ${segments.length ? 'w-[14%]' : 'flex-1'}`}
        title={unknownParts.join(', ') || 'Total unknown'} aria-hidden="true" data-allocation-unknown />}
    </div>
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-soft">
      {segments.map(part => <li key={part.key} className="inline-flex items-center gap-1.5" title={part.title}>
        <Swatch color={part.color} />{part.label} {formatBytes(part.bytes)}
      </li>)}
      {unknown && !pending && <li title={unknownParts.join(', ')}>{segments.length ? 'Other allocations unknown' : 'Allocations unknown'}{!segments.length && fileBytes !== null ? ` · ${formatBytes(fileBytes)} weights on disk` : ''}</li>}
    </ul>
    {plan?.reason === 'context-over-max' && <p className="text-xs text-warning-text">That is more context than this model supports.</p>}
    {over && plan.shortByBytes != null && <p className="text-xs text-danger-text">This won’t load as set: short by {formatBytes(plan.shortByBytes)} of {unified ? 'unified memory' : plan.reason === 'ram' ? 'RAM' : 'VRAM'}.</p>}
    {plan && (plan.disk.tableBytes > 0 || plan.disk.overflowBytes > 0) && <p className="text-xs text-warning-text">
      {plan.disk.tableBytes > 0 && `Lookup table: ${formatBytes(plan.disk.tableBytes)} on SSD. `}{plan.disk.overflowBytes > 0 && `Reads about ${formatBytes(plan.disk.overflowBytes)} from SSD as needed.`}
    </p>}
  </section>;
}
