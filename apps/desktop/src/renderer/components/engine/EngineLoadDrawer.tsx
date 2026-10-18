import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FIT_REQUEST,
  type AutoFitSummary,
  type EngineLoadPreset,
  type FitPlan,
  type GpuFit,
  type KvCacheDtype,
  type LoadParams,
  type LocalModel,
} from '@nekko-agent/shared';
import { FitBar } from '../runtimes/FitBar.js';
import { Toggle } from '../primitives/index.js';
import { formatBytes, formatTokens, verdictColor, verdictLabel, verdictNotes, verdictSentence } from '../runtimes/verdict.js';
import { useStore } from '../../store.js';

/**
 * One model's load settings, in the two shapes people ask for them.
 *
 * **Simple** is a single question, "how much of this machine may it use", solved
 * into real settings by the fit planner. **Advanced** is every flag llama.cpp
 * takes. They are the same state, not two modes: solving the simple slider fills
 * the advanced fields, and editing an advanced field moves the simple readout,
 * so switching tabs never discards what you just did.
 *
 * The memory bar is the honest part. It is the same projection the other runtimes
 * get, with one difference: because the file is ours we read its GGUF header, so
 * the layer geometry is known and the answer is exact rather than partial.
 */

const CONTEXT_STOPS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
const PLAN_DEBOUNCE_MS = 150;

type Surface = 'simple' | 'advanced';

export function EngineLoadDrawer({
  providerId,
  model,
  autoloaded = false,
  onToggleAutoload,
  onFetchCompanions,
  onDone,
  onClose,
  initialSurface = 'simple',
}: {
  providerId: string;
  model: LocalModel & { loaded: boolean };
  /** In the list loaded when the engine starts. */
  autoloaded?: boolean;
  onToggleAutoload?: (on: boolean) => void;
  /** Fetch the projector and config sidecars this model's repo ships. */
  onFetchCompanions?: () => void;
  onDone: () => void;
  onClose: () => void;
  /** Which surface it opens on; a jump from "where does it run" lands on Advanced. */
  initialSurface?: Surface;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [budget, setBudget] = useState(model.preset?.budgetFraction ?? 0.75);
  const [params, setParams] = useState<LoadParams>(() => fromPreset(model.preset));
  const [plan, setPlan] = useState<FitPlan | null>(null);
  const [auto, setAuto] = useState<AutoFitSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [solving, setSolving] = useState(false);
  const latestPlan = useRef(0);
  const latestAuto = useRef(0);

  const stops = useMemo(() => {
    const max = model.maxContext ?? 131072;
    const usable = CONTEXT_STOPS.filter((s) => s <= max);
    if (usable.at(-1) !== max) usable.push(max);
    return usable;
  }, [model.maxContext]);

  /** Solve the budget into settings, and adopt them as the live parameters. */
  const solve = useCallback(
    async (fraction: number) => {
      const seq = ++latestAuto.current;
      setSolving(true);
      const res = await window.nekko
        .runtimeAutoFit(providerId, model.id, fraction, params.parallelSlots)
        .catch(() => null);
      if (seq !== latestAuto.current) return;
      setSolving(false);
      setAuto(res);
      if (!res) return;
      setParams((p) => ({
        ...p,
        contextTokens: res.request.contextTokens,
        kvCacheDtype: res.request.kvCacheDtype,
        gpuLayers:
          res.plan.totalLayers && res.request.gpuLayerFraction < 1
            ? Math.round(res.plan.totalLayers * res.request.gpuLayerFraction)
            : undefined,
      }));
    },
    [providerId, model.id, params.parallelSlots],
  );

  // Solve once on open, and whenever the slider settles.
  useEffect(() => {
    if (surface !== 'simple') return;
    const t = setTimeout(() => void solve(budget), PLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `solve` changes with parallelSlots, which is exactly when it should re-run.
  }, [budget, surface, solve]);

  // The projection for whatever the parameters currently say, in either surface.
  useEffect(() => {
    const seq = ++latestPlan.current;
    const t = setTimeout(async () => {
      const next = await window.nekko
        .runtimePlan(providerId, model.id, {
          ...DEFAULT_FIT_REQUEST,
          contextTokens: params.contextTokens ?? DEFAULT_FIT_REQUEST.contextTokens,
          parallelSlots: params.parallelSlots ?? 1,
          kvCacheDtype: params.kvCacheDtype ?? 'f16',
          gpuLayerFraction:
            params.gpuLayers !== undefined && model.layers ? Math.min(1, params.gpuLayers / model.layers) : 1,
        })
        .catch(() => null);
      if (seq === latestPlan.current) setPlan(next);
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [providerId, model.id, model.layers, params]);

  const patch = (p: Partial<LoadParams>) => setParams((prev) => ({ ...prev, ...p }));

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
    await window.nekko.engineSaveModelPreset(model.id, { ...params, budgetFraction: budget });
    pushToast('success', `Saved as the default settings for ${model.name}.`);
    onDone();
  };

  const ctxIndex = Math.max(0, stops.indexOf(nearest(stops, params.contextTokens ?? 8192)));

  return (
    <div className="mt-2 rounded-xl border p-3" style={{ borderColor: 'var(--line)' }} data-engine-load-drawer={surface}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px]">{model.name}</p>
          <p className="text-[11px] text-ink-faint">
            {[model.parameterSize, model.quantization, model.maxContext && `${formatTokens(model.maxContext)} max`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {plan && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px]"
              style={{
                color: verdictColor(plan.verdict),
                border: `1px solid color-mix(in srgb, ${verdictColor(plan.verdict)} 40%, transparent)`,
              }}
            >
              {verdictLabel(plan.verdict)}
            </span>
          )}
          <SurfaceToggle value={surface} onChange={setSurface} />
        </div>
      </div>

      {/* "Model settings" is its own named, foldable group: the ask is to
          adjust here and reload, not to read past a wall of controls to find
          out whether it fits. The performance readout sits below it. */}
      <details open className="mt-3 rounded-lg border" style={{ borderColor: 'var(--line)' }}>
        <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium">
          Model settings
        </summary>
        <div className="border-t px-3 pb-3" style={{ borderColor: 'var(--line)' }}>
          {surface === 'simple' ? (
            <SimpleSurface budget={budget} onBudget={setBudget} auto={auto} solving={solving} />
          ) : (
            <AdvancedSurface
              model={model}
              params={params}
              stops={stops}
              ctxIndex={ctxIndex}
              onChange={patch}
            />
          )}

          {/* Residency and startup are one question — "how does this model
              behave when I am not looking at it" — so they sit together rather
              than being a load flag and a server setting. */}
          <div className="mt-3 space-y-2 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--line)' }}>
            {onToggleAutoload && (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[12px]">Load when the engine starts</p>
                  <p className="text-[11px] text-ink-faint">Comes up with these saved settings every time the engine does.</p>
                </div>
                <Toggle value={autoloaded} onChange={onToggleAutoload} />
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px]">Keep it loaded</p>
                <p className="text-[11px] text-ink-faint">
                  Never evict it for sitting idle. Off means the server's idle limit applies.
                </p>
              </div>
              <Toggle
                value={params.ttlSeconds === 0}
                onChange={(v) => patch({ ttlSeconds: v ? 0 : undefined })}
              />
            </div>
            {model.modality === 'vision' && !model.hasProjector && onFetchCompanions && (
              <div className="flex items-center justify-between gap-3 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
                <div>
                  <p className="text-[12px]">Projector file missing</p>
                  <p className="text-[11px] text-ink-faint">
                    This model can read images only with its mmproj-*.gguf beside it. Text works either way.
                  </p>
                </div>
                <button className="btn btn-outline shrink-0 py-1 text-[11.5px]" onClick={onFetchCompanions}>
                  Fetch it
                </button>
              </div>
            )}
          </div>
        </div>
      </details>

      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Performance</p>
      {plan ? (
        <FitBar plan={plan} />
      ) : (
        <div className="mt-2 h-6 animate-pulse rounded-md bg-[color-mix(in_srgb,var(--ink-faint)_10%,transparent)]" />
      )}
      {plan && <p className="mt-2 text-[12px]">{verdictSentence(plan)}</p>}
      {plan &&
        verdictNotes(plan).map((n) => (
          <p key={n} className="mt-1 text-[11px] text-ink-faint">
            {n}
          </p>
        ))}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary py-1.5 text-[12px]" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : model.loaded ? 'Reload with these settings' : 'Load model'}
        </button>
        <button className="btn btn-outline py-1.5 text-[12px]" onClick={saveDefault} title="Use these settings every time this model loads">
          Save as default
        </button>
        <button className="btn btn-ghost py-1.5 text-[12px]" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** The small horizontal tab strip: one pick out of a few, accent on the live one. */
function SegTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string; disabled?: boolean; title?: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full border p-0.5 text-[11px]" style={{ borderColor: 'var(--line)' }}>
      {options.map((o) => (
        <button
          key={o.id}
          className="rounded-full px-2.5 py-0.5 disabled:opacity-40"
          disabled={o.disabled}
          title={o.title}
          style={
            value === o.id
              ? { background: 'var(--accent)', color: 'var(--on-accent, #fff)' }
              : { color: 'var(--ink-faint)' }
          }
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SurfaceToggle({ value, onChange }: { value: Surface; onChange: (s: Surface) => void }) {
  return (
    <SegTabs
      options={[
        { id: 'simple', label: 'Simple' },
        { id: 'advanced', label: 'Advanced' },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/**
 * Where the layers run, read off `gpuLayers`: 0 is all-CPU, everything (or an
 * unset "let the engine offload it all") is GPU-only, anything in between is
 * the hybrid split. GPU-only writes the layer count explicitly rather than
 * leaving it unset, so "all of it" survives engines whose default would
 * split to fit.
 */
type Placement = 'gpu' | 'hybrid' | 'cpu';

function placementOf(params: LoadParams, layers?: number): Placement {
  if (params.gpuLayers === 0) return 'cpu';
  if (params.gpuLayers === undefined || (layers !== undefined && params.gpuLayers >= layers)) return 'gpu';
  return 'hybrid';
}

/**
 * One slider and two sentences.
 *
 * The sentences say what was chosen and what it costs in memory. They
 * deliberately do not predict tokens per second: we can measure memory and would
 * be inventing speed, and a number people can catch you being wrong about is
 * worse than no number.
 */
function SimpleSurface({
  budget,
  onBudget,
  auto,
  solving,
}: {
  budget: number;
  onBudget: (n: number) => void;
  auto: AutoFitSummary | null;
  solving: boolean;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[12px]">
        <label htmlFor="engine-budget">How much of this machine may it use?</label>
        <span className="font-mono text-[11px] text-ink-faint">{Math.round(budget * 100)}%</span>
      </div>
      <input
        id="engine-budget"
        type="range"
        className="mt-1 w-full"
        min={30}
        max={95}
        step={5}
        value={Math.round(budget * 100)}
        onChange={(e) => onBudget(Number(e.target.value) / 100)}
      />
      <div className="flex justify-between text-[10.5px] text-ink-faint">
        <span>Leave my machine usable</span>
        <span>Everything it has</span>
      </div>

      <div className="mt-2 min-h-[2.5rem]" style={{ opacity: solving ? 0.6 : 1 }}>
        {auto ? (
          <>
            <p className="text-[12.5px]">{auto.headline}</p>
            <p className="text-[11.5px] text-ink-faint">{auto.tradeoff}</p>
            {auto.compromises.map((c) => (
              <p key={c} className="mt-0.5 text-[11px] text-ink-faint">
                {c}
              </p>
            ))}
          </>
        ) : (
          <p className="text-[12px] text-ink-faint">Working out what fits…</p>
        )}
      </div>
    </div>
  );
}

/** Every flag llama.cpp takes, grouped so the common ones come first. */
function AdvancedSurface({
  model,
  params,
  stops,
  ctxIndex,
  onChange,
}: {
  model: LocalModel & { gpuFit?: GpuFit };
  params: LoadParams;
  stops: number[];
  ctxIndex: number;
  onChange: (p: Partial<LoadParams>) => void;
}) {
  const placement = placementOf(params, model.layers);
  // The planner's verdict doubles as hardware knowledge: 'cpu' means it looked
  // and found no GPU, so GPU-only is a choice that could never do anything.
  const noGpu = model.gpuFit === 'cpu';
  const setPlacement = (p: Placement) =>
    onChange({
      gpuLayers:
        p === 'gpu'
          ? (model.layers ?? 999)
          : p === 'cpu'
            ? 0
            : Math.max(1, Math.floor((model.layers ?? 40) / 2)),
    });
  return (
    <div className="mt-3 space-y-3">
      <div>
        <div className="flex items-center justify-between text-[12px]">
          <label htmlFor="engine-ctx">Context length</label>
          <span className="font-mono text-[11px] text-ink-faint">{formatTokens(params.contextTokens ?? 8192)}</span>
        </div>
        <input
          id="engine-ctx"
          type="range"
          className="mt-1 w-full"
          min={0}
          max={stops.length - 1}
          step={1}
          value={ctxIndex}
          onChange={(e) => onChange({ contextTokens: stops[Number(e.target.value)] })}
        />
      </div>

      {model.format === 'mlx' ? (
        <Row label="Runs on" hint="MLX models live on the GPU; a Mac shares one memory pool between it and the CPU.">
          <span className="text-[11px] text-ink-faint">GPU only</span>
        </Row>
      ) : (
        <Row
          label="Runs on"
          hint={
            placement === 'gpu'
              ? 'Every layer lives in VRAM. Fastest, when the model fits.'
              : placement === 'cpu'
                ? 'Everything runs in system memory. Slower, but it always fits.'
                : 'Split it: the layers you choose run on the GPU, the rest on the CPU.'
          }
        >
          <SegTabs
            options={[
              { id: 'gpu', label: 'GPU only', disabled: noGpu, title: noGpu ? 'No GPU on this machine' : undefined },
              { id: 'hybrid', label: 'Hybrid', disabled: noGpu, title: noGpu ? 'No GPU on this machine' : undefined },
              { id: 'cpu', label: 'CPU only' },
            ]}
            value={placement}
            onChange={setPlacement}
          />
        </Row>
      )}

      {placement === 'hybrid' && model.format !== 'mlx' && (
        <>
          {model.layers ? (
            <Row
              label="GPU offload"
              hint={`How many of the model's ${model.layers} layers run on the GPU. The rest run on the CPU.`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={model.layers}
                  value={params.gpuLayers ?? model.layers}
                  onChange={(e) => onChange({ gpuLayers: Number(e.target.value) })}
                  className="w-28"
                />
                <span className="w-14 text-right font-mono text-[11px] text-ink-faint">
                  {params.gpuLayers ?? model.layers}/{model.layers}
                </span>
              </div>
            </Row>
          ) : (
            <Row label="GPU offload" hint="This file does not say how many layers it has, so set the count directly.">
              <NumberInput
                value={params.gpuLayers}
                min={1}
                max={999}
                placeholder="layers"
                onChange={(n) => onChange({ gpuLayers: n })}
              />
            </Row>
          )}
          <Row label="CPU threads" hint="Threads for the layers that run on the CPU. Empty lets the engine choose.">
            <NumberInput value={params.threads} min={1} max={256} placeholder="auto" onChange={(n) => onChange({ threads: n })} />
          </Row>
        </>
      )}
      {placement === 'cpu' && model.format !== 'mlx' && (
        <Row label="CPU threads" hint="Threads for the layers that run on the CPU. Empty lets the engine choose.">
          <NumberInput value={params.threads} min={1} max={256} placeholder="auto" onChange={(n) => onChange({ threads: n })} />
        </Row>
      )}

      <Row label="KV cache type" hint="A smaller element halves or quarters the cache, at a small quality cost.">
        <select
          className="input w-28 py-1 text-[12px]"
          value={params.kvCacheDtype ?? 'f16'}
          onChange={(e) => onChange({ kvCacheDtype: e.target.value as KvCacheDtype })}
        >
          <option value="f16">f16 (full)</option>
          <option value="q8_0">q8_0 (half)</option>
          <option value="q4_0">q4_0 (quarter)</option>
        </select>
      </Row>

      <Row label="Parallel slots" hint="Concurrent requests. Each slot gets its own full KV cache, so 4 slots means 4x the cache.">
        <NumberInput
          value={params.parallelSlots}
          min={1}
          max={32}
          placeholder="1"
          onChange={(n) => onChange({ parallelSlots: n })}
        />
      </Row>

      <Row label="Flash attention" hint="Cuts attention memory and usually speeds generation up, where the build supports it.">
        <select
          className="input w-24 py-1 text-[12px]"
          value={params.flashAttention === undefined ? 'auto' : params.flashAttention ? 'on' : 'off'}
          onChange={(e) =>
            onChange({ flashAttention: e.target.value === 'auto' ? undefined : e.target.value === 'on' })
          }
        >
          <option value="auto">Auto</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </Row>

      <Row
        label="Speculative decoding"
        hint="Guesses upcoming tokens from text already in the conversation and checks them in one pass. Edits that repeat their input come out several times faster."
      >
        <Toggle value={params.speculative !== false} onChange={(on) => onChange({ speculative: on ? undefined : false })} />
      </Row>

      {params.speculative !== false && <DraftModelRow model={model} value={params.draftModelId} onChange={(id) => onChange({ draftModelId: id })} />}

      <details className="rounded-lg border" style={{ borderColor: 'var(--line)' }}>
        <summary className="cursor-pointer select-none px-3 py-2 text-[12px] text-ink-faint">
          Compute and memory
        </summary>
        <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: 'var(--line)' }}>
          <Row label="Batch size" hint="Tokens processed per prompt batch. Larger is faster and uses more memory.">
            <NumberInput value={params.batchSize} min={16} max={8192} placeholder="auto" onChange={(n) => onChange({ batchSize: n })} />
          </Row>
          <Row label="Physical batch" hint="The micro-batch the GPU actually runs. Lower it when a large batch runs out of memory.">
            <NumberInput value={params.ubatchSize} min={16} max={4096} placeholder="auto" onChange={(n) => onChange({ ubatchSize: n })} />
          </Row>
          <Row label="Keep weights in RAM" hint="Stops the OS paging the model out. Uses more RAM and avoids a stall after idle.">
            <Toggle value={params.mlock ?? false} onChange={(v) => onChange({ mlock: v })} />
          </Row>
          <Row label="Memory-map the file" hint="On by default. Turning it off reads the whole model in, which is slower to start but avoids disk stalls.">
            <Toggle value={params.mmap !== false} onChange={(v) => onChange({ mmap: v })} />
          </Row>
        </div>
      </details>

      <details className="rounded-lg border" style={{ borderColor: 'var(--line)' }}>
        <summary className="cursor-pointer select-none px-3 py-2 text-[12px] text-ink-faint">
          Sampling and context scaling
        </summary>
        <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: 'var(--line)' }}>
          <Row label="RoPE frequency base" hint="Overrides the model's rotary base, for running past its trained context. Leave empty unless you know you need it.">
            <NumberInput value={params.ropeFreqBase} min={0} max={10_000_000} placeholder="model default" onChange={(n) => onChange({ ropeFreqBase: n })} />
          </Row>
          <Row label="RoPE frequency scale" hint="Linear context scaling. 0.5 doubles the usable window, at a quality cost.">
            <NumberInput value={params.ropeFreqScale} min={0} max={8} step={0.05} placeholder="model default" onChange={(n) => onChange({ ropeFreqScale: n })} />
          </Row>
          <Row label="Seed" hint="Fixes sampling for a reproducible answer. Empty means random.">
            <NumberInput value={params.seed} min={0} max={2 ** 31 - 1} placeholder="random" onChange={(n) => onChange({ seed: n })} />
          </Row>
          <Row label="Unload when idle" hint="Seconds of no requests before the model is evicted. 0 keeps it resident.">
            <NumberInput value={params.ttlSeconds} min={0} max={86_400} placeholder="server default" onChange={(n) => onChange({ ttlSeconds: n })} />
          </Row>
        </div>
      </details>

      {model.architecture && (
        <p className="text-[11px] text-ink-faint">
          {model.architecture} · {model.layers ?? '?'} layers · {model.kvHeads ?? '?'} KV heads
          {model.sizeBytes ? ` · ${formatBytes(model.sizeBytes)} on disk` : ''}
        </p>
      )}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-[12px]">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>
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
      className="input w-24 py-1 text-[12px]"
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
function DraftModelRow({
  model,
  value,
  onChange,
}: {
  model: LocalModel;
  value?: string;
  onChange: (id: string | undefined) => void;
}) {
  const [candidates, setCandidates] = useState<LocalModel[]>([]);
  useEffect(() => {
    let live = true;
    window.nekko
      .engineModels()
      .then((all) => {
        if (!live) return;
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
    <Row label="Draft model" hint="A small model from the same family that guesses ahead. Optional; the lookup above needs none.">
      <select
        className="input w-40 py-1 text-[12px]"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">None</option>
        {candidates.map((m) => (
          <option key={m.id} value={m.id}>{m.id}</option>
        ))}
      </select>
    </Row>
  );
}

function fromPreset(preset?: EngineLoadPreset): LoadParams {
  if (!preset) return {};
  const { budgetFraction: _b, ...params } = preset;
  return params;
}

function nearest(stops: number[], value: number): number {
  return stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), stops[0]);
}
