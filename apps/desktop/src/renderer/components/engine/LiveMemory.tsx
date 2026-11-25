import { useEffect, useMemo, useState } from 'react';
import type { EngineMemory, GpuStats, LoadingModel, LocalModel, ResidentModel, SystemStats } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { StatusDot } from '../primitives/index.js';
import { MemoryBar, OTHER_COLOR, Swatch, seriesColor, shadeOf, type BarSegment } from './MemoryBar.js';
import { breakdown, livePools, type AspectPart, type LivePool, type LiveModelSegment } from './memoryBreakdown.js';
import { contextPerSession, sessionsOf, toPlacementRequest } from './loadSettings.js';

/**
 * Loaded models' live memory bar.
 *
 * What the machine holds right now, refreshed every couple of seconds: other
 * apps, each loaded model (its weights, its context and its working space as
 * shades of its own colour), loads still streaming in, and what is free. One
 * bar per pool: graphics memory and system memory, or one on a Mac. Below the
 * bars each model gets a line with what its memory is for; pointing at a model
 * there or in the bar lights up its part of the bar.
 */

/** Live, but not busy: the probes are cheap and paused while the page is hidden. */
export const LIVE_MS = 2000;

const ASPECT_LABEL: Record<AspectPart['aspect'], string> = {
  weights: 'Weights',
  experts: 'Expert cache',
  context: 'Context',
  working: 'Working space',
  pinned: 'Pinned copy',
  model: 'In memory',
};

export function LiveMemory({
  providerId,
  resident,
  loading,
  models,
  memory,
  reserveBytes,
}: {
  providerId: string;
  resident: ResidentModel[];
  /** Loads still on their way in, not yet resident. */
  loading: LoadingModel[];
  models: Map<string, LocalModel>;
  memory?: EngineMemory;
  reserveBytes: number | null;
}) {
  const [gpu, setGpu] = useState<GpuStats | null>(null);
  const [system, setSystem] = useState<SystemStats | null>(null);
  const [read, setRead] = useState(false);
  const [plans, setPlans] = useState<Map<string, AspectPart[] | null>>(new Map());
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const [g, s] = await Promise.all([
        window.nekko.getGpuStats?.().catch(() => null) ?? null,
        window.nekko.getSystemStats?.().catch(() => null) ?? null,
      ]);
      if (!live) return;
      // A hidden page answers with nothing; keep the last reading rather than blank the bar.
      if (g) setGpu(g);
      if (s) setSystem(s);
      setRead(true);
    };
    void poll();
    const t = setInterval(() => void poll(), LIVE_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // Each model's split, for the settings it was loaded with. Asked again only
  // when the set of models or their settings change, not on every reading.
  const signature = resident.map((r) => `${r.id}:${JSON.stringify(r.params ?? null)}:${models.has(r.id)}`).join('|');
  useEffect(() => {
    let live = true;
    void Promise.all(
      resident.map(async (r) => {
        const model = models.get(r.id);
        if (!model || !r.params || model.modality === 'image') return [r.id, null] as const;
        const plan = await window.nekko.runtimePlace(providerId, r.id, toPlacementRequest(r.params, model)).catch(() => null);
        return [r.id, plan && plan.verdict !== 'unknown' ? breakdown(plan, r.params, model.layers) : null] as const;
      }),
    ).then((entries) => {
      if (live) setPlans(new Map(entries));
    });
    return () => {
      live = false;
    };
  }, [providerId, signature]);

  const pools = useMemo(
    () =>
      livePools({
        gpu,
        system,
        unified: memory?.kind === 'unified',
        models: resident.map((r) => ({
          id: r.id,
          name: models.get(r.id)?.name ?? r.id,
          parts: plans.get(r.id) ?? null,
          measuredVramBytes: r.vramBytes,
          fallbackBytes: r.vramBytes ?? r.sizeBytes ?? 0,
          loadedOn: r.loadedOn,
        })),
        loading: loading
          .filter((l) => l.phase === 'loading')
          .map((l) => ({
            id: l.id,
            name: models.get(l.id)?.name ?? l.id,
            landedBytes: l.vram ? l.vram.beforeBytes - l.vram.freeBytes : 0,
            needBytes: l.vram?.needBytes ?? 0,
          })),
        reserveBytes,
      }),
    [gpu, system, memory?.kind, resident, loading, models, plans, reserveBytes],
  );

  if (!pools.length) {
    // Before the first reading, a placeholder of the bar's height; with no
    // probe at all, the plain total the page always had.
    const total = resident.reduce((n, r) => n + (r.vramBytes ?? r.sizeBytes ?? 0), 0);
    if (!read) return <span className="mt-(--q-heading) block h-4 rounded bg-surface-2" aria-hidden />;
    return total > 0 && memory?.budgetBytes ? (
      <div className="mt-(--q-heading)">
        <span className="block h-2 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label="Model memory in use" aria-valuemin={0} aria-valuemax={memory.budgetBytes} aria-valuenow={total}>
          <span className="block h-full rounded-full bg-accent transition-[width] duration-(--dur-slow) ease-(--ease-out)" style={{ width: `${Math.min(100, (total / memory.budgetBytes) * 100)}%` }} />
        </span>
        <p className="mt-(--q-tight) text-2xs text-ink-faint">
          {formatBytes(total)} of {formatBytes(memory.budgetBytes)}
        </p>
      </div>
    ) : null;
  }

  // One line per model, whichever pools it sits in.
  const legend = new Map<string, { seg: LiveModelSegment; byPool: Array<{ pool: LivePool; seg: LiveModelSegment }> }>();
  for (const pool of pools) {
    for (const seg of pool.models) {
      const e = legend.get(seg.id) ?? { seg, byPool: [] };
      e.byPool.push({ pool, seg });
      legend.set(seg.id, e);
    }
  }

  return (
    <div className="mt-(--q-heading) space-y-(--q-inline)" data-live-memory onMouseLeave={() => setHover(null)}>
      {pools.map((pool, i) => (
        <PoolBar key={pool.key} pool={pool} hover={hover} onHover={setHover} live={i === 0} />
      ))}
      <ul className="space-y-(--q-tight)" data-live-legend>
        {[...legend.values()].map(({ seg, byPool }) => {
          const r = resident.find((x) => x.id === seg.id);
          const total = byPool.reduce((n, p) => n + p.seg.bytes, 0);
          return (
            <li
              key={seg.id}
              className="-mx-2 flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-md px-2 py-0.5 text-xs transition-[background-color] duration-(--dur-fast) hover:bg-(--q-wash)"
              onMouseEnter={() => setHover(seg.id)}
              onMouseLeave={() => setHover(null)}
              data-live-legend-row={seg.id}
            >
              <span className="self-center">
                <Swatch color={seriesColor(seg.series)} hatched={!!seg.loading} />
              </span>
              <span className="shrink-0 font-medium">{seg.name}</span>
              <span className="shrink-0 font-mono text-2xs text-ink-faint">{formatBytes(total)}</span>
              {/* Wraps under the name on a narrow window rather than cutting off. */}
              <span className="min-w-[14rem] flex-1 pl-4 text-ink-faint sm:pl-0">
                {seg.loading
                  ? `loading · ${formatBytes(seg.bytes)} of about ${formatBytes(seg.loading.needBytes)} in`
                  : partsText(byPool, r)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Weights 4.1 GB · Context 2.0 GB, 4 × 8k · Working space 600 MB", pools named when there are two. */
function partsText(byPool: Array<{ pool: LivePool; seg: LiveModelSegment }>, r: ResidentModel | undefined): string {
  const two = byPool.length > 1;
  return byPool
    .map(({ pool, seg }) => {
      const parts = seg.parts.map((p) => {
        const sessions = p.aspect === 'context' && r?.params ? sessionsOf(r.params) : 1;
        const ctx = p.aspect === 'context' && r?.params
          ? `, ${sessions > 1 ? `${sessions} × ` : ''}${formatTokens(contextPerSession(r.params))}`
          : '';
        return `${ASPECT_LABEL[p.aspect]} ${formatBytes(p.bytes)}${ctx}`;
      });
      return two ? `${pool.key === 'vram' ? 'VRAM' : 'RAM'}: ${parts.join(', ')}` : parts.join(' · ');
    })
    .join(' · ');
}

function PoolBar({
  pool,
  hover,
  onHover,
  live,
}: {
  pool: LivePool;
  hover: string | null;
  onHover: (id: string | null) => void;
  live: boolean;
}) {
  const ours = pool.models.reduce((n, m) => n + m.bytes, 0);
  const used = pool.otherBytes + ours;
  const segments: BarSegment[] = [
    {
      key: 'other',
      bytes: pool.otherBytes,
      color: OTHER_COLOR,
      title: `Other apps ${formatBytes(pool.otherBytes)}`,
      dim: hover !== null,
    },
    ...pool.models.flatMap((m) => {
      const dim = hover !== null && hover !== m.id;
      const hoverMe = (on: boolean) => onHover(on ? m.id : null);
      const parts: BarSegment[] = m.parts.map((p) => ({
        key: `${m.id}:${p.aspect}`,
        bytes: p.bytes,
        color: shadeOf(m.series, p.aspect),
        title: `${m.name}: ${ASPECT_LABEL[p.aspect].toLowerCase()} ${formatBytes(p.bytes)}${p.slices ? `, ${p.slices} parallel sessions` : ''}`,
        slices: p.slices,
        hatched: !!m.loading,
        dim,
        onHover: hoverMe,
      }));
      if (m.loading && m.loading.needBytes > m.bytes) {
        parts.push({
          key: `${m.id}:pending`,
          bytes: m.loading.needBytes - m.bytes,
          color: shadeOf(m.series, 'pinned'),
          title: `${m.name}: about ${formatBytes(m.loading.needBytes - m.bytes)} still to load`,
          hatched: true,
          dim,
          onHover: hoverMe,
        });
      }
      return parts;
    }),
  ];
  return (
    <div data-live-pool={pool.key}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-2 font-medium">
          {pool.title}
          {live && (
            <span className="inline-flex items-center gap-1 text-2xs font-normal text-ink-faint" title="Read from this machine every 2 seconds">
              <StatusDot tone="success" pulse size={6} />
              Live
            </span>
          )}
        </span>
        <span className="font-mono text-2xs text-ink-faint">
          {formatBytes(used)} of {formatBytes(pool.totalBytes)}
        </span>
      </div>
      <div className="mt-(--q-tight)">
        <MemoryBar
          segments={segments}
          scaleBytes={pool.scaleBytes}
          label={`${pool.title} in use`}
          over={used > pool.totalBytes}
          marker={pool.reserveAtBytes ? { atBytes: pool.reserveAtBytes, title: `Overload protection keeps the last ${formatBytes(pool.totalBytes - pool.reserveAtBytes)} free` } : undefined}
        />
      </div>
      <div className="mt-(--q-tight) flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Swatch color={OTHER_COLOR} />
          Other apps {formatBytes(pool.otherBytes)}
        </span>
        <span>Models {formatBytes(ours)}</span>
        <span className="ml-auto">Free {formatBytes(pool.freeBytes)}</span>
      </div>
    </div>
  );
}
