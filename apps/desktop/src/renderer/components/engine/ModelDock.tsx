import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_FIT_REQUEST } from '@nekko-agent/shared';
import type {
  EngineStatus,
  FitPlan,
  GpuFit,
  KvCacheDtype,
  LoadParams,
  LocalModel,
  ResidentModel,
} from '@nekko-agent/shared';
import { readBrandKey } from '../../brandStorage.js';
import { useStore } from '../../store.js';
import { ChevronIcon } from '../../icons.js';
import { Toggle } from '../primitives/index.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';

/**
 * What a loaded model is running on, one fold away in the right rail.
 *
 * The answer to "is it on the GPU" used to live on the Models page, which you
 * only see when you go looking. Here it sits where the question is asked —
 * beside the chat and above the machine's meters — and the same group lets you
 * change a resident model's settings and reload it without leaving the chat.
 * It only appears while the engine is installed: a dock about models you cannot
 * run is a decoration.
 */

const PROVIDER_ID = 'nekko-engine';
const POLL_MS = 6000;
const DOCK_OPEN_KEY = 'nekko.modelDock.open';
const CONTEXT_STOPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
const PLAN_DEBOUNCE_MS = 300;
/** Chromium's native range thumb, which the marker offset has to allow for. */
const THUMB_PX = 16;

type Row = { model: LocalModel & { loaded: boolean; gpuFit?: GpuFit }; resident: ResidentModel };

export function ModelDock() {
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' ? true : readBrandKey(window.localStorage, DOCK_OPEN_KEY) !== 'off',
  );
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<Array<LocalModel & { loaded: boolean; gpuFit?: GpuFit }>>([]);
  // Which resident model's settings are unfolded.
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => []),
    ]);
    setStatus(s);
    setModels(m);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(DOCK_OPEN_KEY, next ? 'on' : 'off');
      } catch {
        /* private mode */
      }
      return next;
    });

  const rows: Row[] = useMemo(() => {
    const byId = new Map(models.map((m) => [m.id, m]));
    return (status?.resident ?? [])
      .map((r) => ({ resident: r, model: byId.get(r.id) }))
      .filter((r): r is Row => Boolean(r.model));
  }, [status, models]);

  // No engine, no dock — nothing here could ever load a model.
  if (!status?.install.binPath) return null;

  return (
    <div className={`shrink-0 border-t border-line px-4 text-[11px] ${open ? 'py-4' : 'py-2'}`}>
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={toggle}
        aria-expanded={open}
        title={open ? 'Collapse model settings' : 'Show the loaded models and their settings'}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
          Model settings
          {rows.length > 0 && <span className="chip text-[9px]">{rows.length} loaded</span>}
        </span>
        {/* Collapsed, still say whether anything runs on the CPU: it is the one
            fact that explains a slow reply without opening the group. */}
        {!open && rows.some((r) => r.resident.loadedOn && r.resident.loadedOn !== 'gpu') && (
          <span className="shrink-0 text-[10px]" style={{ color: 'var(--warning, #d1a054)' }}>
            part on CPU
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2">
          {status.running && rows.length === 0 && (
            <p className="text-[11px] leading-snug text-ink-faint">
              Nothing is in memory yet. Models load on the Models tab, or on their own when a request arrives.
            </p>
          )}
          {!status.running && (
            <p className="text-[11px] leading-snug text-ink-faint">
              The model server is stopped. Start it on the Nekko Server page to load models here.
            </p>
          )}
          {rows.map(({ model, resident }) => (
            <DockRow
              key={resident.id}
              model={model}
              resident={resident}
              expanded={editing === resident.id}
              onToggleExpand={() => setEditing(editing === resident.id ? null : resident.id)}
              onReloaded={(msg, ok) => {
                pushToast(ok ? 'success' : 'error', msg);
                setEditing(null);
                void refresh();
              }}
              onUnloaded={(msg, ok) => {
                pushToast(ok ? 'info' : 'error', msg);
                setEditing(null);
                void refresh();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One resident model: where it runs, and folded under it the settings it runs with. */
function DockRow({
  model,
  resident,
  expanded,
  onToggleExpand,
  onReloaded,
  onUnloaded,
}: {
  model: LocalModel & { loaded: boolean; gpuFit?: GpuFit };
  resident: ResidentModel;
  expanded: boolean;
  onToggleExpand: () => void;
  onReloaded: (message: string, ok: boolean) => void;
  onUnloaded: (message: string, ok: boolean) => void;
}) {
  // What the row opened with: the saved preset, corrected by what the server
  // says it actually loaded. The preset can be stale (a load from the Models
  // tab with one-off settings, or a request-triggered load at the default), and
  // "Reload with changes" only means something measured against what is live.
  const initial = useMemo<LoadParams>(
    () => ({
      ...(model.preset ?? {}),
      ...(resident.contextLength ? { contextTokens: resident.contextLength } : {}),
    }),
    [model.preset, resident.contextLength],
  );
  const [params, setParams] = useState<LoadParams>(initial);
  const [busy, setBusy] = useState<'reload' | 'unload' | null>(null);
  const split = resident.loadedOn === 'gpu+cpu' || resident.loadedOn === 'cpu';

  // Every unfold starts from what is loaded now, not from an edit abandoned the
  // last time the row was open or from settings a reload has since replaced.
  useEffect(() => {
    if (expanded) setParams(initial);
    // Only the unfold resets: a poll refreshing `initial` mid-edit must not
    // throw away what the user is in the middle of changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const reload = async () => {
    setBusy('reload');
    const res = await window.nekko
      .runtimeLoad(PROVIDER_ID, model.id, params)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);
    onReloaded(res.message ?? (res.ok ? `${model.name} reloaded.` : 'Could not reload it.'), res.ok);
  };

  const unload = async () => {
    setBusy('unload');
    const res = await window.nekko
      .unloadModel(PROVIDER_ID, model.id)
      .catch(() => ({ ok: false, message: "Couldn't unload it." }));
    setBusy(null);
    onUnloaded(res.message ?? (res.ok ? `${model.name} unloaded.` : "Couldn't unload it."), res.ok);
  };

  const patch = (p: Partial<LoadParams>) => setParams((prev) => ({ ...prev, ...p }));

  // The slider runs to everything the model can serve, not to a round number
  // that happens to be below it. Powers of two make the stops a person thinks
  // in; the exact maximum and the live context are added so neither has to be
  // rounded away to be shown. A resident context past the trained maximum (a
  // RoPE stretch) widens the range rather than being clamped off it.
  const maxCtx = Math.max(model.maxContext ?? resident.contextLength ?? 131072, resident.contextLength ?? 0);
  const ctxStops = useMemo(() => {
    const set = new Set(CONTEXT_STOPS.filter((s) => s <= maxCtx));
    set.add(maxCtx);
    if (initial.contextTokens && initial.contextTokens <= maxCtx) set.add(initial.contextTokens);
    return [...set].sort((a, b) => a - b);
  }, [maxCtx, initial.contextTokens]);
  const ctx = params.contextTokens ?? initial.contextTokens ?? 8192;
  const ctxIndex = Math.max(0, ctxStops.indexOf(nearest(ctxStops, ctx)));

  const vramLimit = useVramContextLimit({
    model,
    resident,
    active: expanded,
    maxCtx,
    gpuLayers: params.gpuLayers,
    kvCacheDtype: params.kvCacheDtype ?? 'f16',
    parallelSlots: params.parallelSlots ?? 1,
  });
  // Red only when we know: an undetermined limit is not a warning.
  const overVram = vramLimit !== null && ctx > vramLimit;
  const limitAt = vramLimit === null ? null : positionOf(ctxStops, vramLimit);
  const limitTitle =
    vramLimit === null
      ? undefined
      : vramLimit >= maxCtx
        ? 'Fits in VRAM at the full context'
        : vramLimit < ctxStops[0]
          ? `Does not fit in VRAM even at ${formatTokens(ctxStops[0])} with these settings`
          : `Fits in VRAM up to ${formatTokens(vramLimit)}`;

  const dirty = !sameSettings(params, initial, model.layers);

  return (
    <div className="rounded-lg border border-line">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        title={expanded ? 'Fold the settings away' : `Adjust and reload ${model.name}`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: split ? 'var(--warning, #d1a054)' : 'var(--success)' }}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink-soft" title={model.path}>
          {model.name}
        </span>
        {resident.loadedOn && (
          <span
            className="shrink-0 text-[10px] tabular-nums"
            style={split ? { color: 'var(--warning, #d1a054)' } : undefined}
            title={placementTitle(resident)}
          >
            {placementLabel(resident)}
          </span>
        )}
        <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Where it sits and what it holds, at a glance. */}
      <p className="px-2.5 pb-1.5 text-[10px] tabular-nums text-ink-faint">
        {[
          formatBytes(resident.vramBytes ?? resident.sizeBytes ?? 0),
          resident.contextLength ? `${formatTokens(resident.contextLength)} context` : undefined,
          model.gpuFit && model.gpuFit !== 'full' && model.gpuFit !== 'unknown'
            ? model.gpuFit === 'wont'
              ? "won't fit this machine"
              : model.gpuFit === 'cpu'
                ? 'no GPU to offload to'
                : 'spills to CPU under current settings'
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {expanded && (
        <div className="space-y-2 border-t border-line px-2.5 py-2.5">
          {/* Unloading is a property of the row, not of the edit, so it sits
              in the corner rather than beside the reload it has nothing to do with. */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Settings</span>
            {/* The quick fields below are a subset; everything else (Runs on,
                threads, batch, flash attention) is one jump away. */}
            <button
              className="ml-auto text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink"
              data-local-model-settings={model.id}
              onClick={() => useStore.getState().openLocalModelSettings(model.id)}
              title={`Open all of ${model.name}'s settings on Nekko Server`}
            >
              All settings
            </button>
            <button
              className="btn btn-outline h-6 rounded-lg px-2 py-0.5 text-[11px] disabled:opacity-60"
              disabled={busy !== null}
              onClick={() => void unload()}
              title={`Free the memory ${model.name} is holding`}
            >
              {busy === 'unload' ? 'Unloading…' : 'Unload'}
            </button>
          </div>
          <Field label="GPU layers" value={model.layers ? `${params.gpuLayers ?? model.layers}/${model.layers}` : 'all'}>
            {model.layers ? (
              <input
                type="range"
                className="w-full"
                min={0}
                max={model.layers}
                value={params.gpuLayers ?? model.layers}
                onChange={(e) => patch({ gpuLayers: Number(e.target.value) })}
              />
            ) : (
              <p className="text-[10px] text-ink-faint">This file does not say how many layers it has.</p>
            )}
          </Field>
          <Field label="Context" value={`${formatTokens(ctx)} of ${formatTokens(maxCtx)}`}>
            <ContextSlider
              stops={ctxStops}
              index={ctxIndex}
              over={overVram}
              limitAt={limitAt}
              limitTitle={limitTitle}
              label={`Context for ${model.name}`}
              onChange={(i) => patch({ contextTokens: ctxStops[i] })}
            />
            {overVram && (
              <p className="mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--danger)' }}>
                Past {formatTokens(vramLimit ?? 0)} the KV cache spills out of VRAM, so replies slow down.
              </p>
            )}
          </Field>
          <Field label="KV cache">
            <select
              className="input w-full py-1 text-[11px]"
              value={params.kvCacheDtype ?? 'f16'}
              onChange={(e) => patch({ kvCacheDtype: e.target.value as KvCacheDtype })}
            >
              <option value="f16">f16 (full)</option>
              <option value="q8_0">q8_0 (half)</option>
              <option value="q4_0">q4_0 (quarter)</option>
            </select>
          </Field>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-ink-soft" title="Never evict it for sitting idle">
              Keep it loaded
            </span>
            <Toggle
              value={params.ttlSeconds === 0}
              onChange={(v) => patch({ ttlSeconds: v ? 0 : undefined })}
              label={`Keep ${model.name} loaded`}
            />
          </div>
          {/* Nothing to apply, nothing to offer: a reload button that is always
              there reads as something you are meant to press. */}
          {(dirty || busy === 'reload') && (
            <>
              <p className="text-[10px] leading-snug text-ink-faint">
                Changes apply on reload: the model is unloaded and brought back with these settings.
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-primary h-6 flex-1 rounded-lg py-0.5 text-[11px] disabled:opacity-60"
                  disabled={busy !== null}
                  onClick={() => void reload()}
                >
                  {busy === 'reload' ? 'Reloading…' : 'Reload with changes'}
                </button>
                <button
                  className="shrink-0 text-[11px] text-ink-faint hover:text-ink disabled:opacity-60"
                  disabled={busy !== null}
                  onClick={() => setParams(initial)}
                  title="Discard these edits"
                >
                  Reset
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The largest context that keeps this model's share of the work on the GPU,
 * under the other settings being edited, or null when that cannot be said.
 *
 * The planner cannot simply be asked "does this fit" here, because the model is
 * loaded: the free VRAM it measures is what is left *beside* this model, and a
 * reload frees this model's own memory before taking it again. So one plan is
 * fetched (at the full context, all layers on the GPU, so the overhead term has
 * reached its cap and nothing is scaled), and the answer is solved from its byte
 * breakdown against the free VRAM plus what this model holds right now:
 *
 *   on GPU(ctx) = (weights + kvPerToken * ctx) * offloadShare + overhead
 *
 * The KV cache is linear in context, so one plan gives its per-token cost
 * exactly; scaling it by the offload share follows llama.cpp, which keeps each
 * offloaded layer's cache beside that layer. The plan is keyed by what it
 * depends on (KV type, slots) and only fetched while the row is unfolded, so
 * dragging the layer slider re-solves without another round trip.
 */
function useVramContextLimit({
  model,
  resident,
  active,
  maxCtx,
  gpuLayers,
  kvCacheDtype,
  parallelSlots,
}: {
  model: LocalModel;
  resident: ResidentModel;
  active: boolean;
  maxCtx: number;
  gpuLayers?: number;
  kvCacheDtype: KvCacheDtype;
  parallelSlots: number;
}): number | null {
  const [plan, setPlan] = useState<FitPlan | null>(null);
  // Plans for this unfold, by request. Folding the row drops them: free VRAM
  // moves as other models come and go, and a stale plan draws a wrong marker.
  const cache = useRef(new Map<string, FitPlan | null>());
  const latest = useRef(0);
  const key = `${kvCacheDtype}|${parallelSlots}|${maxCtx}`;

  useEffect(() => {
    if (!active) {
      cache.current.clear();
      setPlan(null);
      return;
    }
    const hit = cache.current.get(key);
    if (hit !== undefined) {
      setPlan(hit);
      return;
    }
    const seq = ++latest.current;
    const t = setTimeout(async () => {
      const next = await window.nekko
        .runtimePlan(PROVIDER_ID, model.id, {
          ...DEFAULT_FIT_REQUEST,
          contextTokens: maxCtx,
          parallelSlots,
          kvCacheDtype,
          gpuLayerFraction: 1,
        })
        .catch(() => null);
      cache.current.set(key, next);
      if (seq === latest.current) setPlan(next);
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active, key, model.id, maxCtx, parallelSlots, kvCacheDtype]);

  return useMemo(() => {
    // No GPU, no geometry, or an answer the planner itself would not give: say
    // nothing rather than draw a confident line in the wrong place.
    if (!plan || plan.verdict === 'unknown' || !plan.deviceName) return null;
    if (plan.kvCacheBytes <= 0 || plan.weightsBytes <= 0) return null;
    // What this model holds on the GPU now comes back on reload. `vramBytes` is
    // measured; a model the server says is wholly on the GPU without a figure
    // is credited its size instead. A CPU-resident model frees no VRAM.
    const own =
      resident.loadedOn === 'cpu'
        ? 0
        : (resident.vramBytes ?? (resident.loadedOn === 'gpu' ? (resident.sizeBytes ?? 0) : 0));
    const available = plan.deviceFreeBytes + own;
    const share = model.layers && gpuLayers !== undefined ? Math.min(1, Math.max(0, gpuLayers / model.layers)) : 1;
    // Nothing offloaded means nothing to overflow: the whole range fits.
    if (share === 0) return maxCtx;
    const kvPerToken = plan.kvCacheBytes / maxCtx;
    const room = available - plan.overheadBytes - plan.weightsBytes * share;
    if (room <= 0) return 0;
    return Math.min(maxCtx, Math.floor(room / (kvPerToken * share)));
  }, [plan, resident.loadedOn, resident.vramBytes, resident.sizeBytes, model.layers, gpuLayers, maxCtx]);
}

/**
 * A real range input over the context stops, with the VRAM line drawn on it.
 *
 * The input stays native so keyboard, screen readers and the value text all
 * behave; only its colour and an overlaid tick are ours. The tick sits where the
 * limit falls between the stops on either side of it, so a limit of 48k reads as
 * halfway between 32k and 64k rather than snapping onto one of them.
 */
function ContextSlider({
  stops,
  index,
  over,
  limitAt,
  limitTitle,
  label,
  onChange,
}: {
  stops: number[];
  index: number;
  over: boolean;
  /** 0..1 along the track, or null when the limit is unknown. */
  limitAt: number | null;
  limitTitle?: string;
  label: string;
  onChange: (index: number) => void;
}) {
  const color = over ? 'var(--danger)' : 'var(--accent)';
  const last = Math.max(1, stops.length - 1);
  // The thumb's centre travels THUMB_PX short of the track's full width, so the
  // tick is placed on the same inset line the thumb runs along.
  const at = (f: number) => `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${f})`;
  return (
    // The title lives on the whole track: a 3px tick is too small to hover, and
    // letting it take pointer events would swallow drags that start on it.
    <div className="relative" title={limitTitle}>
      <input
        type="range"
        className="relative z-0 w-full"
        style={{ accentColor: color }}
        min={0}
        max={last}
        step={1}
        value={index}
        aria-label={label}
        aria-valuetext={`${formatTokens(stops[index] ?? 0)} tokens${over ? ', past what fits in VRAM' : ''}`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {limitAt !== null && limitAt < 1 && (
        <span
          className="pointer-events-none absolute top-1/2 z-10 h-2.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: at(limitAt), background: 'var(--ink-faint)' }}
          aria-hidden
        />
      )}
      {/* The tick is a picture; the sentence is what a screen reader gets. */}
      {limitTitle && <span className="sr-only">{limitTitle}</span>}
    </div>
  );
}

/** 0..1 position of `value` along stops spaced evenly, interpolating between neighbours. */
function positionOf(stops: number[], value: number): number {
  if (stops.length < 2) return 1;
  if (value <= stops[0]) return 0;
  const last = stops.length - 1;
  if (value >= stops[last]) return 1;
  const i = stops.findIndex((s) => s > value);
  const lo = stops[i - 1];
  const hi = stops[i];
  return (i - 1 + (value - lo) / (hi - lo)) / last;
}

function nearest(stops: number[], value: number): number {
  return stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), stops[0]);
}

/**
 * Whether two sets of load settings would load the same thing. Only the fields
 * this dock edits are compared, and an absent value is read as the default it
 * stands for, so opening the row and touching nothing is never "a change".
 */
function sameSettings(a: LoadParams, b: LoadParams, layers?: number): boolean {
  const full = layers ?? Number.MAX_SAFE_INTEGER;
  return (
    (a.gpuLayers ?? full) === (b.gpuLayers ?? full) &&
    (a.contextTokens ?? 8192) === (b.contextTokens ?? 8192) &&
    (a.kvCacheDtype ?? 'f16') === (b.kvCacheDtype ?? 'f16') &&
    (a.ttlSeconds === 0) === (b.ttlSeconds === 0)
  );
}

function Field({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] text-ink-soft">{label}</span>
        {value && <span className="text-[10px] tabular-nums text-ink-faint">{value}</span>}
      </div>
      {children}
    </div>
  );
}
