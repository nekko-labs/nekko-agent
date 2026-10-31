import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GpuFit, LoadParams, LocalModel, PlacementPlan, Recommendation, SplitPreset } from '@nekko-agent/shared';
import { Toggle } from '../primitives/index.js';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { useStore } from '../../store.js';
import {
  KEEP_LABELS,
  PRECISIONS,
  SESSION_STOPS,
  contextPerSession,
  contextStops,
  differsFromLoaded,
  differsFromSaved,
  expertCacheMiB,
  fromPreset,
  fromRecommendation,
  hasTables,
  isMoe,
  keepOf,
  keepParams,
  matchesRecommendation,
  pagesOf,
  precisionOf,
  runOnOf,
  sessionsOf,
  toPlacementRequest,
  type RunOn,
} from './loadSettings.js';

/**
 * One model's load settings, laid out for someone who does not know how models
 * work: what it will use (the meter), one button that picks the fastest setup
 * that fits, then where it runs and how much it remembers, with everything else
 * folded under More controls and Expert.
 *
 * There is one state, the `LoadParams` the engine launches with. The meter is
 * the placement planner's answer for exactly those parameters
 * (`crates/nekko-engine/src/placement.rs`), and the launch passes the
 * placement explicitly with `--fit off`, so what loads is what the meter showed.
 * It deliberately predicts memory, never tokens per second: we can measure the
 * one and would be inventing the other.
 */

const PLAN_DEBOUNCE_MS = 150;
/** The meter's "other apps" figures move; re-read them while the drawer is open. */
const LIVE_REFRESH_MS = 5000;

export function EngineLoadDrawer({
  providerId,
  model,
  loadedParams,
  autoloaded = false,
  onToggleAutoload,
  onFetchCompanions,
  onDone,
  onClose,
  initialSurface = 'simple',
}: {
  providerId: string;
  model: LocalModel & { loaded: boolean; gpuFit?: GpuFit };
  /** What the running copy was loaded with, when the engine says. */
  loadedParams?: LoadParams;
  /** In the list loaded when the engine starts. */
  autoloaded?: boolean;
  onToggleAutoload?: (on: boolean) => void;
  /** Fetch the projector and config sidecars this model's repo ships. */
  onFetchCompanions?: () => void;
  onDone: () => void;
  onClose: () => void;
  /** A jump from "where does it run" opens with More controls unfolded. */
  initialSurface?: 'simple' | 'advanced';
}) {
  const pushToast = useStore((s) => s.pushToast);
  const saved = useMemo(() => fromPreset(model.preset), [model.preset]);
  const [params, setParams] = useState<LoadParams>(saved.params);
  const [split, setSplit] = useState<SplitPreset>(saved.split);
  const [plan, setPlan] = useState<PlacementPlan | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [applied, setApplied] = useState(false);
  const [more, setMore] = useState(initialSurface === 'advanced');
  const [expert, setExpert] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const layers = model.layers;
  const moe = isMoe(model);
  const mlx = model.format === 'mlx';
  const stops = useMemo(() => contextStops(model.maxContext), [model.maxContext]);

  const patch = (p: Partial<LoadParams>) => setParams((prev) => ({ ...prev, ...p }));
  /** A hand edit to placement is a custom split. */
  const patchCustom = (p: Partial<LoadParams>) => {
    setSplit('custom');
    patch(p);
  };

  const applyRecommendation = useCallback(
    (r: Recommendation) => {
      setParams((prev) => fromRecommendation(r.request, model, prev));
      setSplit(r.request.runOn === 'hybrid' ? 'fill' : 'custom');
      setApplied(true);
    },
    [model],
  );

  // The recommendation, once per open. With no saved settings it is applied
  // straight away, so a model opened for the first time shows a setup that fits.
  useEffect(() => {
    let live = true;
    window.nekko
      .runtimeRecommend(providerId, model.id, { goal: 'speed' })
      .then((r) => {
        if (!live || !r) return;
        setRec(r);
        if (!model.preset) applyRecommendation(r);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Re-solving on every params change would chase the user's own edits.
  }, [providerId, model.id]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  // The meter: where these exact parameters put every byte.
  useEffect(() => {
    const seq = ++latest.current;
    const t = setTimeout(async () => {
      const next = await window.nekko.runtimePlace(providerId, model.id, toPlacementRequest(params, model)).catch(() => null);
      if (seq === latest.current) setPlan(next);
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [providerId, model, params, tick]);

  const runOn = runOnOf(params, layers);
  const unified = plan?.unified ?? false;
  const noGpu = model.gpuFit === 'cpu' || (plan !== null && plan.deviceName === null);
  const matches = matchesRecommendation(params, rec?.request, layers);
  // A load from chat or at engine start uses the saved settings, not these.
  const unsaved = differsFromSaved(params, saved.params);
  // Save as default does not touch the running copy; only a reload does.
  const stale = !unsaved && model.loaded && !!loadedParams && differsFromLoaded(params, loadedParams);

  const setRunOn = (r: RunOn) => {
    setSplit('custom');
    patch(
      r === 'gpu'
        ? { gpuLayers: layers ?? 999, cpuMoeLayers: undefined, cpuFfnLayers: undefined, kvOnGpu: undefined, moeCacheMiB: undefined }
        : r === 'cpu'
          ? { gpuLayers: 0, cpuMoeLayers: undefined, cpuFfnLayers: undefined, moeCacheMiB: undefined }
          : { gpuLayers: Math.max(1, Math.floor((layers ?? 40) / 2)), cpuMoeLayers: undefined, cpuFfnLayers: undefined },
    );
  };

  const pickPreset = async (p: SplitPreset) => {
    const full = { gpuLayers: layers ?? 999, cpuMoeLayers: undefined, cpuFfnLayers: undefined, kvOnGpu: undefined, moeCacheMiB: undefined };
    setSplit(p);
    if (p === 'custom') return patch({ cpuMoeLayers: undefined, cpuFfnLayers: undefined, moeCacheMiB: undefined, kvOnGpu: undefined });
    if (p === 'context-ram') return patch({ ...full, kvOnGpu: false });
    if (p === 'experts') {
      const next = { ...params, ...full, cpuMoeLayers: layers, lazyTables: hasTables(model) ? true : params.lazyTables };
      const placed = await window.nekko.runtimePlace(providerId, model.id, toPlacementRequest(next, model)).catch(() => null);
      return setParams({ ...next, moeCacheMiB: placed ? expertCacheMiB(placed, model) : undefined });
    }
    const goal = p === 'coding' ? 'context' : 'fill';
    const r = await window.nekko
      .runtimeRecommend(providerId, model.id, { goal, request: { ...toPlacementRequest({ ...params, ...full }, model), runOn: 'hybrid' } })
      .catch(() => null);
    if (!r) return pushToast('error', "Couldn't work out a split that fits.");
    setParams((prev) => ({ ...fromRecommendation(r.request, model, prev), ...(p === 'coding' ? { speculative: undefined } : {}) }));
  };

  const load = async () => {
    setLoading(true);
    const req = window.nekko
      .runtimeLoad(providerId, model.id, params)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    // Refresh now so the "In memory" block gains its loading row while the
    // file is still streaming in, not when it has already landed.
    onDone();
    const res = await req;
    setLoading(false);
    pushToast(res.ok ? 'success' : 'error', res.message ?? (res.ok ? 'Loaded.' : "Couldn't load the model."));
    if (res.ok) {
      onDone();
      onClose();
    }
  };

  const saveDefault = async () => {
    await window.nekko.engineSaveModelPreset(model.id, { ...params, splitPreset: split });
    pushToast('success', `Saved as the default settings for ${model.name}.`);
    onDone();
  };

  const perSession = contextPerSession(params);
  const sessions = sessionsOf(params);
  const ctxIndex = Math.max(0, stops.indexOf(nearest(stops, perSession)));
  const setContext = (perSessionTokens: number) => {
    if (split === 'coding') setSplit('custom');
    patch({ contextTokens: perSessionTokens * sessions });
  };
  const setSessions = (n: number) => patch({ contextTokens: perSession * n, parallelSlots: n > 1 ? n : undefined });
  const keep = keepOf(params);

  return (
    <div className="mt-2 rounded-xl border p-4" style={{ borderColor: 'var(--line)' }} data-engine-load-drawer>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{model.name}</p>
          <p className="text-xs text-ink-faint">
            {[
              model.parameterSize,
              model.quantization,
              moe && model.weightLayout?.experts && `${model.weightLayout.experts} experts`,
              model.maxContext && `${formatTokens(model.maxContext)} max`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {plan && <VerdictChip plan={plan} />}
      </div>

      <MemoryMeter plan={plan} />

      <div className="mt-3">
        <button
          className="btn btn-primary flex min-h-[52px] w-full items-center justify-center gap-2 text-base font-semibold"
          onClick={() => rec && applyRecommendation(rec)}
          disabled={!rec}
          data-recommend
        >
          <BoltIcon />
          Use recommended settings
        </button>
        <p className="mt-1 text-center text-xs text-ink-faint">
          Picks the fastest setup that fits this model on this machine. GPU first, always.
        </p>
        {applied && rec && (
          <div className="mt-2 rounded-lg border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'var(--accent-soft)' }}>
            <p className="text-xs font-medium">What this chose</p>
            <div className="mt-1 space-y-1">
              {rec.why.map((w) => (
                <div key={w.field} className="flex gap-3 text-xs">
                  <span className="w-32 shrink-0 text-ink-faint">{w.field}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{w.value}.</span> {w.sentence}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {mlx ? (
        <Section title="Run on" hint="MLX models live on the GPU; a Mac shares one memory pool between it and the CPU." />
      ) : unified ? (
        <Section
          title="Run on"
          hint="Your Mac shares one pool of memory between the GPU and the CPU, so there is nothing to split. The model runs on the GPU."
        />
      ) : (
        <Section
          title="Run on"
          recommended={matches.runOn}
          hint={
            runOn === 'gpu'
              ? 'GPU only: the whole model lives in graphics memory. Fastest, when it fits.'
              : runOn === 'hybrid'
                ? 'Hybrid: the graphics card and system memory share the model, so bigger models fit. Choose how below.'
                : 'CPU only is on (set under Expert). Pick GPU only or Hybrid to use the graphics card.'
          }
          control={
            <SegTabs
              label="Run on"
              options={[
                { id: 'gpu', label: 'GPU only', disabled: noGpu, title: noGpu ? 'No GPU on this machine' : undefined },
                { id: 'hybrid', label: 'Hybrid', disabled: noGpu, title: noGpu ? 'No GPU on this machine' : undefined },
              ]}
              value={runOn === 'cpu' ? null : runOn}
              onChange={(r) => setRunOn(r)}
              data="run-on"
            />
          }
        />
      )}

      {runOn === 'hybrid' && !unified && !mlx && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }} data-split>
          <p className="text-xs font-medium">How to split it</p>
          <p className="text-xs text-ink-faint">
            Ready-made ways to share the work between the graphics card and system memory. Custom lets you set it by hand.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {splitPresets(moe, hasTables(model)).map((p) => (
              <button
                key={p.id}
                className="flex min-h-[44px] flex-col gap-0.5 rounded-lg border px-3 py-2 text-left disabled:opacity-45"
                style={
                  split === p.id
                    ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                    : { borderColor: 'var(--line)' }
                }
                aria-pressed={split === p.id}
                onClick={() => void pickPreset(p.id)}
                data-preset={p.id === 'custom' ? undefined : p.id}
                data-split-option={p.id}
              >
                <span className="text-xs font-medium">{p.label}</span>
                <span className="text-xs text-ink-faint">{p.hint}</span>
              </button>
            ))}
          </div>
          {split === 'custom' && layers ? (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="engine-gpu-layers">Layers on the graphics card</label>
                <span className="font-mono text-2xs text-ink-faint">
                  {params.gpuLayers ?? layers} of {layers}
                </span>
              </div>
              <input
                id="engine-gpu-layers"
                type="range"
                className="mt-1 w-full"
                min={1}
                max={layers}
                value={params.gpuLayers ?? layers}
                onChange={(e) => patchCustom({ gpuLayers: Number(e.target.value) })}
              />
              <p className="text-xs text-ink-faint">
                A model is a stack of layers. Each one on the graphics card makes it faster and uses more graphics memory.
              </p>
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="engine-ctx" className="text-sm font-medium">
            Context {matches.context && <RecommendedTag />}
          </label>
          <span className="font-mono text-xs" data-context-label>
            {formatTokens(perSession)} per session{sessions > 1 ? ` · ${formatTokens(perSession * sessions)} total` : ''}
          </span>
        </div>
        <input
          id="engine-ctx"
          type="range"
          className="mt-1 w-full"
          min={0}
          max={stops.length - 1}
          step={1}
          value={ctxIndex}
          onChange={(e) => setContext(stops[Number(e.target.value)])}
        />
        <div className="flex justify-between text-2xs text-ink-faint">
          <span>{formatTokens(stops[0])}</span>
          <span>{formatTokens(stops[stops.length - 1])} (model max)</span>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          How much the model can keep in mind at once: your messages, its replies and any files it reads.{' '}
          {formatTokens(perSession)} is roughly {pagesOf(perSession)} pages of text. More context uses more memory, and the meter
          above shows how much.
        </p>
      </div>

      <div className="mt-4 rounded-lg border" style={{ borderColor: 'var(--line)' }}>
        <Fold label="More controls" open={more} onToggle={() => setMore((v) => !v)} id="more" />
        {more && (
          <div className="space-y-4 border-t px-3 pb-3 pt-3" style={{ borderColor: 'var(--line)' }}>
            <Slider
              id="engine-sessions"
              label="Sessions at once"
              recommended={matches.sessions}
              value={Math.max(0, SESSION_STOPS.indexOf(nearest(SESSION_STOPS, sessions)))}
              max={SESSION_STOPS.length - 1}
              readout={sessions === 1 ? '1 session' : `${sessions} sessions`}
              ends={['1', rec ? `Recommended here: ${rec.request.sessions}` : '', '8']}
              onChange={(i) => setSessions(SESSION_STOPS[i])}
              hint={`How many chats or agents can get answers at the same time. Each one keeps its own context, so more sessions use more memory.${sessions > 1 ? ` Each of the ${sessions} gets ${formatTokens(perSession)}.` : ''}`}
            />
            <Slider
              id="engine-precision"
              label="Memory precision"
              recommended={matches.precision}
              value={precisionOf(params)}
              max={PRECISIONS.length - 1}
              readout={`${PRECISIONS[precisionOf(params)].label} (${params.kvCacheDtype ?? 'f16'})`}
              ends={['Most reliable', '', 'Faster, smaller']}
              onChange={(i) => patch({ kvCacheDtype: PRECISIONS[i].dtype })}
              hint={`How exactly the model stores what it has read so far. Lower precision fits more context and runs a little faster, with a small risk of losing track of details in very long work.${precisionOf(params) === 2 ? ' Fastest is best kept for chat; for long coding work, Balanced is the safer pick.' : ''}`}
            />
            <Slider
              id="engine-keep"
              label="Keep in memory"
              value={keep}
              max={2}
              readout={KEEP_LABELS[keep]}
              ends={KEEP_LABELS}
              onChange={(i) => patch(keepParams(i))}
              hint={`${
                keep === 0
                  ? 'Loads the model when a chat needs it and lets it go after it sits idle, so memory comes back to your other apps.'
                  : keep === 1
                    ? 'Keeps the model ready after the first load, so the next reply starts instantly.'
                    : 'Keeps it ready and stops the computer from ever swapping it out, so nothing stalls after a quiet spell. Holds a full copy in system memory.'
              } This uses system memory, but it does not move the work off your graphics card: the GPU still does the thinking.`}
            />

            <div className="rounded-lg border" style={{ borderColor: 'var(--line)' }}>
              <Fold label="Expert" open={expert} onToggle={() => setExpert((v) => !v)} id="expert" />
              {expert && (
                <ExpertControls
                  model={model}
                  params={params}
                  runOn={runOn}
                  unified={unified}
                  onChange={patch}
                  onChangePlacement={patchCustom}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {(onToggleAutoload || (model.modality === 'vision' && !model.hasProjector && onFetchCompanions)) && (
        <div className="mt-3 space-y-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          {onToggleAutoload && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs">Load when the engine starts</p>
                <p className="text-2xs text-ink-faint">Comes up with these saved settings every time the engine does.</p>
              </div>
              <Toggle value={autoloaded} onChange={onToggleAutoload} label="Load when the engine starts" />
            </div>
          )}
          {model.modality === 'vision' && !model.hasProjector && onFetchCompanions && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs">Projector file missing</p>
                <p className="text-2xs text-ink-faint">
                  This model can read images only with its mmproj-*.gguf beside it. Text works either way.
                </p>
              </div>
              <button className="btn btn-outline shrink-0 py-1 text-xs" onClick={onFetchCompanions}>
                Fetch it
              </button>
            </div>
          )}
        </div>
      )}

      {unsaved && (
        <p className="mt-4 text-2xs text-ink-faint" data-unsaved>
          These settings apply to this load only. Save as default to keep them.
        </p>
      )}
      {stale && (
        <p className="mt-4 text-2xs text-ink-faint" data-stale>
          The loaded model still runs with its earlier settings. Reload to use these now.
        </p>
      )}
      <div className={`${unsaved || stale ? 'mt-2' : 'mt-4'} flex flex-wrap items-center gap-2`}>
        <button className="btn btn-primary py-1 text-xs" onClick={load} disabled={loading} data-load>
          {loading ? 'Loading…' : model.loaded ? 'Reload with these settings' : 'Load model'}
        </button>
        <button className="btn btn-outline py-1 text-xs" onClick={saveDefault} title="Use these settings every time this model loads">
          Save as default
        </button>
        <button className="btn btn-ghost py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function splitPresets(moe: boolean, tables: boolean): Array<{ id: SplitPreset; label: string; hint: string }> {
  const list: Array<{ id: SplitPreset; label: string; hint: string }> = [
    { id: 'custom', label: 'Custom', hint: 'Choose how many layers go on the graphics card.' },
    moe
      ? { id: 'fill', label: 'Fill the GPU, rest in RAM', hint: 'As many experts on the graphics card as fit at this context; the rest wait in system memory. The fastest hybrid.' }
      : { id: 'fill', label: 'Attention on GPU, the rest in RAM', hint: 'Keeps the attention math and the context on the graphics card and moves the bulky feed-forward part of some layers to system memory.' },
  ];
  if (moe) {
    list.push(
      { id: 'experts', label: 'All experts in RAM', hint: 'Only the core sits on the graphics card, leaving the most room for context. A small cache keeps the busiest experts on the GPU.' },
      {
        id: 'coding',
        label: 'Long coding sessions',
        hint: `Experts in RAM${tables ? ', the lookup table on your SSD' : ''}, the most context in compact memory, and repeated code guessed ahead.`,
      },
    );
  }
  list.push({ id: 'context-ram', label: 'Context in RAM', hint: 'The whole model on the graphics card, its memory of the conversation in system RAM. For long context on a model that only just fits.' });
  return list;
}

const VERDICTS: Record<PlacementPlan['verdict'], { label: string; color: string }> = {
  fits: { label: 'Fits', color: 'var(--success)' },
  tight: { label: 'Fits, just', color: 'var(--warning)' },
  disk: { label: 'Reads from SSD', color: 'var(--warning)' },
  'wont-load': { label: 'Won’t fit', color: 'var(--danger)' },
  unknown: { label: 'Unknown', color: 'var(--ink-faint)' },
};

function VerdictChip({ plan }: { plan: PlacementPlan }) {
  const v = VERDICTS[plan.verdict];
  return (
    <span
      className="whitespace-nowrap rounded-full px-3 py-0.5 text-xs"
      style={{ color: v.color, border: `1px solid color-mix(in srgb, ${v.color} 45%, transparent)` }}
      data-verdict={plan.verdict}
    >
      {v.label}
    </span>
  );
}

const SEG = {
  other: 'color-mix(in srgb, var(--ink-faint) 55%, transparent)',
  weights: 'var(--accent)',
  kv: 'var(--accent-2)',
  overhead: 'color-mix(in srgb, var(--accent) 50%, var(--accent-2))',
  pinned: 'color-mix(in srgb, var(--accent) 35%, transparent)',
};

/**
 * Graphics memory and system memory as two bars: other apps, this model (its
 * weights, its context, its working space), and what is left. A load that will
 * not fit runs the bar past its end in red; the line under it says what is read
 * from the SSD.
 */
function MemoryMeter({ plan }: { plan: PlacementPlan | null }) {
  if (!plan) return <div className="mt-3 h-24 animate-pulse rounded-lg bg-[color-mix(in_srgb,var(--ink-faint)_10%,transparent)]" />;
  if (plan.verdict === 'unknown') {
    return (
      <p className="mt-3 rounded-lg border px-3 py-2 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        This file does not describe its layers, so we cannot say how much memory it needs. Load it and we will measure it.
      </p>
    );
  }
  const bars = plan.unified
    ? [{ title: 'Memory (shared by GPU and CPU)', pool: plan.vram, extra: plan.ram.model }]
    : [
        ...(plan.deviceName ? [{ title: 'Graphics memory (VRAM)', pool: plan.vram, extra: null }] : []),
        { title: 'System memory (RAM)', pool: plan.ram, extra: null },
      ];
  const disk: string[] = [];
  if (plan.disk.tableBytes > 0) disk.push(`Its lookup table (${formatBytes(plan.disk.tableBytes)}) stays on your SSD and is read a few KB per word.`);
  if (plan.disk.overflowBytes > 0) disk.push(`Reads about ${formatBytes(plan.disk.overflowBytes)} of the model from your SSD as it needs it. A fast NVMe drive matters here.`);
  return (
    <section aria-label="Memory" className="mt-3 space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }} data-meter>
      {bars.map(({ title, pool, extra }) => {
        const m = pool.model;
        const parts = [
          { label: 'Model', bytes: m.weightsBytes + (extra?.weightsBytes ?? 0), color: SEG.weights },
          { label: 'Context', bytes: m.kvCacheBytes + (extra?.kvCacheBytes ?? 0), color: SEG.kv },
          { label: 'Working space', bytes: m.overheadBytes + (extra?.overheadBytes ?? 0), color: SEG.overhead },
          { label: 'Pinned copy', bytes: m.pinnedBytes, color: SEG.pinned },
        ].filter((p) => p.bytes > 0);
        const mine = parts.reduce((a, p) => a + p.bytes, 0);
        const room = Math.max(0, pool.totalBytes - pool.otherBytes);
        const over = mine > pool.availBytes;
        const scale = Math.max(pool.totalBytes, pool.otherBytes + mine, 1);
        const pct = (b: number) => `${(b / scale) * 100}%`;
        return (
          <div key={title} data-meter-bar>
            <div className="flex justify-between gap-3 text-xs">
              <span className="font-medium">{title}</span>
              <span className="font-mono text-2xs text-ink-faint">
                {formatBytes(pool.otherBytes + mine)} of {formatBytes(pool.totalBytes)}
              </span>
            </div>
            <div
              className="mt-1 flex h-4 overflow-hidden rounded"
              style={{ background: 'color-mix(in srgb, var(--ink-faint) 14%, transparent)', outline: over ? '2px solid var(--danger)' : undefined }}
            >
              <div style={{ width: pct(pool.otherBytes), background: SEG.other }} title={`Other apps ${formatBytes(pool.otherBytes)}`} />
              {parts.map((p) => (
                <div key={p.label} style={{ width: pct(p.bytes), background: p.color }} title={`${p.label} ${formatBytes(p.bytes)}`} />
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink-faint">
              <Legend color={SEG.other} text={`Other apps ${formatBytes(pool.otherBytes)}`} />
              {parts.map((p) => (
                <Legend key={p.label} color={p.color} text={`${p.label} ${formatBytes(p.bytes)}`} />
              ))}
              <span style={over ? { color: 'var(--danger)' } : undefined}>
                {over ? `Short by ${formatBytes(mine - pool.availBytes)}` : `Free ${formatBytes(room - mine)}`}
              </span>
            </div>
          </div>
        );
      })}
      {disk.length > 0 && (
        <p className="text-xs" style={{ color: 'var(--warning)' }} data-meter-disk>
          {disk.join(' ')}
        </p>
      )}
      <p className="text-xs">{expectation(plan)}</p>
    </section>
  );
}

function expectation(plan: PlacementPlan): string {
  if (plan.verdict === 'wont-load') {
    if (plan.reason === 'context-over-max') return 'That is more context than this model supports.';
    const pool = plan.reason === 'ram' ? 'system memory' : plan.unified ? 'memory than the GPU may use' : 'graphics memory';
    return `This won’t load as set: it needs ${formatBytes(plan.shortByBytes ?? 0)} more ${pool}. Try Use recommended settings, or lower the context.`;
  }
  if (plan.unified) return 'Runs entirely on the GPU. Macs share memory, so this is already the fastest setup.';
  if (!plan.deviceName || plan.vram.model.weightsBytes === 0) return 'Everything runs on the processor. It always fits, and it is the slowest option.';
  if (plan.ram.model.weightsBytes === 0 && plan.ram.model.kvCacheBytes === 0) return 'Everything runs on the graphics card. This is the fastest way to run a model.';
  if (plan.ram.model.weightsBytes === 0) return 'The model sits on the graphics card and its context lives in system memory. Good for very long context; each word is a little slower.';
  return `The graphics card does the core work; ${formatBytes(plan.ram.model.weightsBytes)} of the model waits in system memory${plan.disk.overflowBytes > 0 ? ' and on your SSD' : ''}. Slower than all-GPU, much faster than the processor alone.`;
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {text}
    </span>
  );
}

function RecommendedTag() {
  return <span className="ml-2 text-2xs font-normal" style={{ color: 'var(--accent)' }}>Recommended</span>;
}

function BoltIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

function Section({ title, hint, control, recommended }: { title: string; hint: string; control?: React.ReactNode; recommended?: boolean }) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">
          {title} {recommended && <RecommendedTag />}
        </span>
        {control}
      </div>
      <p className="mt-1 text-xs text-ink-faint">{hint}</p>
    </div>
  );
}

function Fold({ label, open, onToggle, id }: { label: string; open: boolean; onToggle: () => void; id: string }) {
  return (
    <button className="flex min-h-[40px] w-full items-center justify-between px-3 text-xs font-medium" onClick={onToggle} aria-expanded={open} data-fold={id}>
      {label}
      <span className="font-mono text-ink-faint">{open ? '−' : '+'}</span>
    </button>
  );
}

function Slider({
  id,
  label,
  value,
  max,
  readout,
  ends,
  hint,
  onChange,
  recommended,
}: {
  id: string;
  label: string;
  value: number;
  max: number;
  readout: string;
  ends: string[];
  hint: string;
  onChange: (i: number) => void;
  recommended?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium">
          {label} {recommended && <RecommendedTag />}
        </label>
        <span className="font-mono text-xs">{readout}</span>
      </div>
      <input id={id} type="range" className="mt-1 w-full" min={0} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex justify-between text-2xs text-ink-faint">
        {ends.map((e, i) => (
          <span key={i}>{e}</span>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-faint">{hint}</p>
    </div>
  );
}

/** The small horizontal tab strip: one pick out of a few, accent on the live one. */
function SegTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  data,
}: {
  options: Array<{ id: T; label: string; disabled?: boolean; title?: string }>;
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  data?: string;
}) {
  return (
    <div className="flex rounded-full border p-0.5 text-xs" style={{ borderColor: 'var(--line)' }} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          className="min-h-[32px] rounded-full px-4 disabled:opacity-40"
          disabled={o.disabled}
          title={o.title}
          aria-pressed={value === o.id}
          style={value === o.id ? { background: 'var(--accent)', color: 'var(--on-accent, #fff)' } : { color: 'var(--ink-faint)' }}
          onClick={() => onChange(o.id)}
          {...(data ? { [`data-${data}`]: o.id } : {})}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Every remaining flag, grouped, each with a sentence and the flag it sets. */
export function ExpertControls({
  model,
  params,
  runOn,
  unified,
  onChange,
  onChangePlacement,
}: {
  model: LocalModel;
  params: LoadParams;
  runOn: RunOn;
  unified: boolean;
  onChange: (p: Partial<LoadParams>) => void;
  onChangePlacement: (p: Partial<LoadParams>) => void;
}) {
  const layers = model.layers;
  const moe = isMoe(model);
  return (
    <div className="space-y-4 border-t px-3 pb-3 pt-3" style={{ borderColor: 'var(--line)' }}>
      <Group title="Where it runs">
        {!unified && model.format !== 'mlx' && (
          <Row label="CPU only" flag="--n-gpu-layers 0" hint="Ignore the graphics card and run everything on the processor. Slow, but it always works.">
            <Toggle value={runOn === 'cpu'} onChange={(v) => onChangePlacement({ gpuLayers: v ? 0 : layers, cpuMoeLayers: undefined, cpuFfnLayers: undefined })} label="CPU only" />
          </Row>
        )}
        {runOn === 'hybrid' && (
          <>
            <Row label="Layers on the graphics card" flag="--n-gpu-layers" hint="The same setting as the Custom slider. llama.cpp puts the last layers on the GPU.">
              <NumberInput value={params.gpuLayers} min={0} max={layers ?? 999} placeholder="all" onChange={(n) => onChangePlacement({ gpuLayers: n })} />
            </Row>
            {moe ? (
              <>
                <Row label="Expert layers in RAM" flag="--n-cpu-moe N  (all: --cpu-moe)" hint="How many layers keep their experts in system memory instead of on the graphics card. The model uses only a few experts per word, so this costs less speed than it sounds.">
                  <NumberInput value={params.cpuMoeLayers} min={0} max={layers ?? 999} placeholder="0" onChange={(n) => onChangePlacement({ cpuMoeLayers: n })} />
                </Row>
                <Row label="Expert cache on the graphics card (MB)" flag="--moe-cache-mib" hint="Keeps the experts this model reaches for most often in spare graphics memory. Speeds up replies when experts live in RAM. Needs a recent engine build.">
                  <NumberInput value={params.moeCacheMiB} min={0} max={65536} placeholder="off" onChange={(n) => onChange({ moeCacheMiB: n })} />
                </Row>
              </>
            ) : (
              <Row label="Feed-forward layers in RAM" flag="--n-cpu-ffn N" hint="How many layers run their feed-forward part (the bulkiest piece) from system memory, keeping attention on the graphics card.">
                <NumberInput value={params.cpuFfnLayers} min={0} max={layers ?? 999} placeholder="0" onChange={(n) => onChangePlacement({ cpuFfnLayers: n })} />
              </Row>
            )}
          </>
        )}
        {!unified && runOn !== 'cpu' && (
          <Row label="Context on the graphics card" flag="--no-kv-offload when off" hint="Off moves the conversation memory into system RAM. Frees graphics memory for the model, at some speed cost.">
            <Toggle value={params.kvOnGpu !== false} onChange={(v) => onChangePlacement({ kvOnGpu: v ? undefined : false, gpuLayers: params.gpuLayers ?? layers })} label="Context on the graphics card" />
          </Row>
        )}
        {hasTables(model) && (
          <Row label="Lookup table on disk" flag="--lazy-mode on" hint="This model ships a large table it reads only a few KB of per word. Leave it on your SSD instead of filling memory. Needs Read the file as needed.">
            <Toggle value={params.lazyTables !== false} onChange={(v) => onChange({ lazyTables: v })} disabled={params.mmap === false} label="Lookup table on disk" />
          </Row>
        )}
        <p className="text-2xs text-ink-faint">
          We work out where everything goes before loading and pass it to llama.cpp as is (<span className="font-mono">--fit off</span>), so the meter above is what you get.
        </p>
      </Group>

      {model.format !== 'mlx' && (
        <Group title="Reasoning">
          <Row label="Thinking" flag="chat_template_kwargs.enable_thinking" hint="On by default. Lets reasoning-capable local models think before answering. Applies to this model, not individual chats; models without reasoning may ignore it.">
            <Toggle value={params.thinking !== false} onChange={(v) => onChange({ thinking: v })} label="Thinking" />
          </Row>
        </Group>
      )}

      <Group title="Speed">
        <Row label="Flash attention" flag="--flash-attn" hint="A faster, leaner way to do the attention math. The smaller memory precisions need it. Auto turns it on where this engine supports it.">
          <select
            className="input w-24 py-1 text-xs"
            value={params.flashAttention === undefined ? 'auto' : params.flashAttention ? 'on' : 'off'}
            onChange={(e) => onChange({ flashAttention: e.target.value === 'auto' ? undefined : e.target.value === 'on' })}
          >
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Row>
        <Row label="Processor threads" flag="--threads" hint="How many processor cores work on the parts that run on the CPU. Empty lets the engine choose.">
          <NumberInput value={params.threads} min={1} max={256} placeholder="auto" onChange={(n) => onChange({ threads: n })} />
        </Row>
        <Row label="Threads for reading prompts" flag="--threads-batch" hint="Cores used while the model reads a long message or file, separate from writing the reply.">
          <NumberInput value={params.threadsBatch} min={1} max={256} placeholder="auto" onChange={(n) => onChange({ threadsBatch: n })} />
        </Row>
        <Row label="Batch size" flag="--batch-size" hint="How much of your prompt it reads in one go. Bigger reads long files faster and uses more memory.">
          <NumberInput value={params.batchSize} min={16} max={8192} placeholder="auto" onChange={(n) => onChange({ batchSize: n })} />
        </Row>
        <Row label="Micro-batch" flag="--ubatch-size" hint="The chunk the graphics card actually works on. Lower it if loading fails with an out-of-memory error.">
          <NumberInput value={params.ubatchSize} min={16} max={4096} placeholder="auto" onChange={(n) => onChange({ ubatchSize: n })} />
        </Row>
      </Group>

      <Group title="Guessing ahead">
        <Row label="Speculative decoding" flag="--spec-default" hint="Guesses the next few words from text already in the chat and checks them in one step. Edits that repeat existing code come out several times faster.">
          <Toggle value={params.speculative !== false} onChange={(on) => onChange({ speculative: on ? undefined : false })} label="Speculative decoding" />
        </Row>
        {params.speculative !== false && <DraftModelRow model={model} value={params.draftModelId} onChange={(id) => onChange({ draftModelId: id })} />}
      </Group>

      <Group title="Memory and loading">
        <Row label="Read the file as needed" flag="--load-mode mmap / none" hint="Maps the model file instead of copying it in. Starts faster and lets a model bigger than RAM run from your SSD. Off reads it all in first.">
          <Toggle value={params.mmap !== false} onChange={(v) => onChange({ mmap: v })} label="Read the file as needed" />
        </Row>
        <Row label="Pin in memory" flag="--load-mode mmap+mlock" hint="Stops the computer swapping the model out. Uses a full copy's worth of system memory.">
          <Toggle value={params.mlock ?? false} onChange={(v) => onChange({ mlock: v, ...(v ? { ttlSeconds: 0 } : {}) })} label="Pin in memory" />
        </Row>
        <Row label="Unload when idle (seconds)" flag="ttl" hint="Seconds without a request before the model is let go. 0 keeps it loaded; empty uses the server's limit.">
          <NumberInput value={params.ttlSeconds} min={0} max={86_400} placeholder="server default" onChange={(n) => onChange({ ttlSeconds: n })} />
        </Row>
      </Group>

      <Group title="Long context and repeatability">
        <Row label="RoPE frequency base" flag="--rope-freq-base" hint="Stretches a model past the context it was trained for. Leave it empty unless the model card says to set it.">
          <NumberInput value={params.ropeFreqBase} min={0} max={10_000_000} placeholder="model default" onChange={(n) => onChange({ ropeFreqBase: n })} />
        </Row>
        <Row label="RoPE frequency scale" flag="--rope-freq-scale" hint="The simpler stretch: 0.5 doubles usable context, at a quality cost.">
          <NumberInput value={params.ropeFreqScale} min={0} max={8} step={0.05} placeholder="model default" onChange={(n) => onChange({ ropeFreqScale: n })} />
        </Row>
        <Row label="Seed" flag="--seed" hint="Fix it to get the same answer to the same question every time. Empty means random.">
          <NumberInput value={params.seed} min={0} max={2 ** 31 - 1} placeholder="random" onChange={(n) => onChange({ seed: n })} />
        </Row>
      </Group>

      {model.architecture && (
        <p className="text-2xs text-ink-faint">
          {model.architecture} · {layers ?? '?'} layers · {model.kvHeads ?? '?'} KV heads
          {moe && model.weightLayout ? ` · experts ${Math.round(model.weightLayout.expertShare * 100)}% of the file` : ''}
          {model.sizeBytes ? ` · ${formatBytes(model.sizeBytes)} on disk` : ''}
        </p>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="border-t pt-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, hint, flag, children }: { label: string; hint: string; flag?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-2xs text-ink-faint">{hint}</p>
      {flag && <p className="mt-0.5 font-mono text-2xs text-ink-faint">{flag}</p>}
    </div>
  );
}

/** A number field whose empty state means "unset", not zero. */
function NumberInput({
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      className="input w-24 py-1 text-xs"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

/**
 * An optional second guesser: a small model of the same family. Offered only
 * from the same architecture and well under the target's size, because a
 * draft that is too large slows ordinary replies down (measured: a 7.5B draft
 * on a 12B model halved prose speed while it sped edits up).
 */
function DraftModelRow({ model, value, onChange }: { model: LocalModel; value?: string; onChange: (id: string | undefined) => void }) {
  const [candidates, setCandidates] = useState<LocalModel[]>([]);
  useEffect(() => {
    let live = true;
    window.nekko
      .engineModels()
      .then((all) => {
        if (!live || !all) return;
        const family = model.architecture;
        setCandidates(
          all.filter(
            (m) =>
              m.id !== model.id &&
              Boolean(family) &&
              m.architecture === family &&
              (m.modality === 'draft' || m.modality === 'chat' || !m.modality) &&
              m.sizeBytes <= model.sizeBytes / 4,
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [model.id, model.architecture, model.sizeBytes]);
  if (candidates.length === 0 && !value) return null;
  return (
    <Row label="Draft model" flag="--spec-draft-model" hint="A small model from the same family that guesses ahead. Optional; the guessing above needs none.">
      <select className="input w-40 py-1 text-xs" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">None</option>
        {candidates.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
      </select>
    </Row>
  );
}

function nearest(stops: number[], value: number): number {
  return stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), stops[0]);
}

