import type { FitPlan } from '@nekko-agent/shared';
import { HoverTip } from '../HoverTip.js';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { contextStops } from './loadSettings.js';
import './gpuCapacity.css';

type Band = { id: string; label: string; value: string; detail: string; bytes: number };
type Geometry = Pick<FitPlan, 'weightsBytes' | 'overheadBytes' | 'kvCacheBytes'>;

/** Widths are incremental bytes; context labels are cumulative token milestones. */
export function capacityBands(plan: Geometry, free: number, max: number, recommended: number | null): Band[] {
  const base = plan.weightsBytes + plan.overheadBytes;
  const bands: Band[] = [{ id: 'model', label: 'Model', value: formatBytes(base), bytes: Math.min(base, free),
    detail: `${formatBytes(plan.weightsBytes)} of weights and ${formatBytes(plan.overheadBytes)} of working buffers, before context.${base > free ? " The model alone exceeds available VRAM." : ""}` }];
  let previous = 0;
  const minimum = contextStops(max)[0];
  const add = (id: string, label: string, target: number, why: string) => {
    const end = base + plan.kvCacheBytes * (target / max);
    const start = base + plan.kvCacheBytes * (previous / max);
    bands.push({ id, label, value: formatTokens(target), bytes: Math.min(free, end) - Math.min(free, start),
      detail: `${why} ${formatBytes(end - base)} of context memory (${formatBytes(end)} with the model).${end > free ? " Does not fit now." : " Fits now."}` });
    previous = target;
  };
  add('min', 'Minimum', minimum, 'Smallest context in load settings.');
  if (recommended !== null && recommended >= minimum && recommended <= max) add('rec', 'Recommended', recommended, 'Context per session in the speed recommendation, shown here at default precision.');
  add('max', 'Maximum', max, 'Longest context this model supports.');
  const left = free - base - plan.kvCacheBytes;
  if (left !== 0) bands.push(left > 0
    ? { id: 'free', label: 'Free after max', value: formatBytes(left), bytes: left, detail: 'GPU memory left after loading the model with its full context.' }
    : { id: 'short', label: 'Unavailable', value: formatBytes(-left), bytes: -left, detail: 'Extra VRAM needed to fit the model and its full context. The striped extension is not part of the available memory.' });
  return bands;
}

export function GpuCapacityBar({ bands }: { bands: Band[] }) {
  return <>
    <div className="gpu-capacity-track" aria-hidden="true">
      {bands.filter(b => b.bytes > 0).map(b => <HoverTip key={b.id} heading={b.label + ' · ' + b.value} label={b.detail} side="top">
        <span className="gpu-capacity-fill" data-band={b.id} style={{ flexGrow: b.bytes }} />
      </HoverTip>)}
    </div>
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
      {bands.map(b => <HoverTip key={b.id} heading={b.label + ' · ' + b.value} label={b.detail} side="top">
        <div tabIndex={0} className="gpu-capacity-key">
          <dt className="flex items-center gap-1.5 text-xs text-ink-soft"><i aria-hidden="true" data-band={b.id} />{b.label}</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">{b.value}</dd>
        </div>
      </HoverTip>)}
    </dl>
  </>;
}
