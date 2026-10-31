import { useMemo, useState } from 'react';
import type { GpuFit, LocalModel, ModelModality, ResidentModel } from '@nekko-agent/shared';
import { MODALITY_LABELS, MODEL_FOLDER_PROVIDERS, unsupportedLoadReason } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { CheckIcon, TrashIcon, WarningIcon } from '../../icons.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';
import { ImageGeneration } from './ImageGeneration.js';
import { gpuGuidance } from './modelFamilies.js';

/**
 * The models on this machine.
 *
 * A row is a whole model's state in one line: what it is, what kind of model it
 * is, whether it is in memory, whether it loads at start, and the one action
 * that changes that. Settings live behind the row rather than on it, because
 * the common case is "load this" and the uncommon one is "load this with 32k
 * context and a quantized KV cache".
 *
 * Not every GGUF is a chat model. A diffusion checkpoint, a speech recognizer
 * or a draft head gets its own badge and an explanation instead of a Load
 * button, because letting it fail inside llama-server was how this page used to
 * teach people nothing. A vision model missing its projector still loads, and
 * says plainly what it cannot do until the projector arrives.
 *
 * Not all of them are ours. A model found in Ollama's or LM Studio's folder runs
 * here exactly like one we downloaded, and says where it came from so nobody has
 * to wonder why deleting it is not on offer: that file belongs to another app,
 * and removing it from here would break that app without saying so.
 */

/** The filter is "all" or one bucket; unsupported modalities share a bucket. */
type Filter = 'all' | 'chat' | 'vision' | 'embedding' | 'image' | 'other';

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  chat: 'Chat',
  vision: 'Vision',
  embedding: 'Embeddings',
  image: 'Images',
  other: "Can't run here",
};

function bucketOf(modality?: ModelModality): Filter {
  if (modality === 'vision') return 'vision';
  if (modality === 'embedding') return 'embedding';
  if (modality === 'image') return 'image';
  if (modality === 'audio' || modality === 'draft' || modality === 'unknown') return 'other';
  return 'chat';
}

/** Chip colors per modality: servable kinds are neutral, the rest warn. */
function modalityTone(modality?: ModelModality): string {
  switch (modality) {
    case 'vision':
      return 'var(--accent)';
    case 'embedding':
      return 'var(--success, var(--accent))';
    case 'image':
    case 'audio':
    case 'draft':
    case 'unknown':
      return 'var(--warning, #d1a054)';
    default:
      return 'var(--ink-faint)';
  }
}

export function ModelLibrary({
  providerId,
  models,
  canLoad,
  onChanged,
  query = '',
  autoloadIds,
  running,
  resident,
}: {
  providerId: string;
  models: Array<LocalModel & { loaded: boolean; gpuFit?: GpuFit }>;
  /** The engine's resident list, for where each loaded model actually sits. */
  resident?: ResidentModel[];
  /** False until the engine binary exists: the list is real, running it is not. */
  canLoad: boolean;
  onChanged: () => void;
  /** Live filter from the shared search box (matches name, id, quant, folder). */
  query?: string;
  /** Ids marked to load when the engine starts. */
  autoloadIds?: Set<string>;
  /** Whether the engine is serving: autoload is a promise only while it is. */
  running?: boolean;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const unload = async (id: string) => {
    setBusy(id);
    const res = await window.nekko
      .unloadModel(providerId, id)
      .catch(() => ({ ok: false, message: "Couldn't unload it." }));
    setBusy(null);
    pushToast(res.ok ? 'info' : 'error', res.message ?? 'Unloaded.');
    onChanged();
  };

  const quickLoad = async (model: LocalModel & { loaded: boolean }) => {
    setBusy(model.id);
    // A row's Load uses whatever this model was last saved with, and the planner's
    // own answer when it has never been configured. Opening the drawer is for
    // changing that, not for performing it.
    const params = model.preset ? { ...model.preset, budgetFraction: undefined } : null;
    const req = (params || model.modality === 'image'
      ? window.nekko.runtimeLoad(providerId, model.id, params ?? {})
      : autoLoad(providerId, model.id)).catch((e: Error) => ({ ok: false, message: e.message }));
    // The load is registered the moment the host picks the call up. Refreshing
    // now (and once a beat later, in case this read raced the registration)
    // puts the model in the "In memory" block while it is still streaming in,
    // instead of at whatever the next poll happens to see.
    onChanged();
    const tick = setTimeout(onChanged, 1000);
    const res = await req;
    clearTimeout(tick);
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message ?? (res.ok ? 'Loaded.' : "Couldn't load it."));
    onChanged();
  };

  const remove = async (model: LocalModel) => {
    if (!window.confirm(`Delete ${model.name}? The file is removed from disk.`)) return;
    const res = await window.nekko.engineDeleteModel(model.id);
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  const fetchCompanions = async (model: LocalModel) => {
    setBusy(model.id);
    const res = await window.nekko
      .engineDownloadCompanions(model.id)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  const toggleAutoload = async (model: LocalModel, on: boolean) => {
    await window.nekko.engineSetAutoload(model.id, on).catch(() => null);
    pushToast(
      'info',
      on ? `${model.name} loads when the engine starts.` : `${model.name} no longer loads on start.`,
    );
    onChanged();
  };

  /** How many folders are contributing, for the line above the list. */
  const folders = useMemo(
    () => new Set(models.map((m) => m.folderId ?? 'primary')).size,
    [models],
  );

  /** Which filter buckets this library actually contains, in display order. */
  const buckets = useMemo(() => {
    const present = new Set(models.map((m) => bucketOf(m.modality)));
    return (Object.keys(FILTER_LABELS) as Filter[]).filter((f) => f === 'all' || present.has(f));
  }, [models]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      [m.name, m.id, m.quantization, m.parameterSize, m.sourceRepo, m.folderProvider]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [models, query]);

  const visible = useMemo(
    () => (filter === 'all' ? searched : searched.filter((m) => bucketOf(m.modality) === filter)),
    [searched, filter],
  );

  /**
   * The list groups by where each model lives: our own downloads first, then
   * the other apps' folders alphabetically. Headers only print when there is
   * more than one group to name.
   */
  const groups = useMemo(() => {
    const byLoc = new Map<string, typeof visible>();
    for (const m of visible) {
      const loc = locationOf(m);
      const list = byLoc.get(loc) ?? [];
      list.push(m);
      byLoc.set(loc, list);
    }
    return [...byLoc.entries()].sort(([a], [b]) =>
      a === b ? 0 : a === 'Nekko Agent' ? -1 : b === 'Nekko Agent' ? 1 : a.localeCompare(b),
    );
  }, [visible]);

  /** Residency, by model id: where a loaded model actually sits. */
  const residentById = useMemo(() => new Map((resident ?? []).map((r) => [r.id, r])), [resident]);

  const runImport = async () => {
    const path = importPath.trim();
    if (!path) return;
    const res = await window.nekko.engineImportModel(path);
    pushToast(res.ok ? 'success' : 'error', res.message);
    if (res.ok) {
      setImportPath('');
      setImporting(false);
      onChanged();
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-faint">
          {models.length === 0
            ? 'No models yet.'
            : query.trim() || filter !== 'all'
              ? `${visible.length} of ${models.length} on this machine`
              : `${models.length} model${models.length === 1 ? '' : 's'} · ${formatBytes(
                  models.reduce((n, m) => n + m.sizeBytes, 0),
                )} on disk${folders > 1 ? ` · across ${folders} folders` : ''}`}
        </p>
        <button className="text-xs text-ink-faint hover:text-ink" onClick={() => setImporting((v) => !v)}>
          Add a file I already have
        </button>
      </div>

      {importing && (
        <div className="mt-2 flex gap-2">
          <input
            className="input flex-1 font-mono text-xs"
            placeholder="C:\\models\\qwen2.5-7b-instruct-q4_k_m.gguf"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-outline py-1 text-xs" onClick={runImport} disabled={!importPath.trim()}>
            Add
          </button>
        </div>
      )}

      {buckets.length > 2 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {buckets.map((f) => (
            <button
              key={f}
              className="rounded-full px-2 py-0.5 text-2xs"
              style={
                filter === f
                  ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }
                  : { color: 'var(--ink-faint)' }
              }
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      )}

      {!canLoad && models.length > 0 && (
        <p className="mt-2 rounded-xl border border-dashed px-3 py-2 text-xs" style={{ borderColor: 'var(--line)', color: 'var(--warning)' }}>
          These are on disk and ready. Download the engine above to run them here.
        </p>
      )}

      {models.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed px-4 py-3 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          Nothing here yet. Download one of the picks for this machine above or a model from the list, open{' '}
          <strong>Folders</strong> to point at a folder another app already fills, or add a GGUF you have.
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">
          Nothing on this machine matches {filter !== 'all' ? `${FILTER_LABELS[filter].toLowerCase()} models` : `"${query.trim()}"`}.
        </p>
      ) : (
        <div>
          {groups.map(([loc, ms]) => (
            <div key={loc} className="mt-2">
              {groups.length > 1 && (
                <p className="px-1 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">{loc}</p>
              )}
              <div className="space-y-1">{ms.map(renderRow)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  function renderRow(m: (typeof models)[number]) {
    const unsupported = m.modality === 'image' ? undefined : unsupportedLoadReason(m);
    const missingProjector = m.modality === 'vision' && !m.hasProjector;
    const live = residentById.get(m.id);
    // A model that cannot fill the GPU wears the warning on its row: it will
    // run, but not at the speed the card implies.
    const fitWarn = m.gpuFit === 'partial' || m.gpuFit === 'wont';
    return (
      <div key={m.id}>
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs"
          style={{
            background: 'var(--surface-2)',
            opacity: unsupported ? 0.85 : 1,
            boxShadow: fitWarn ? 'inset 2px 0 0 var(--warning, #d1a054)' : undefined,
          }}
        >
          <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CheckIcon className="h-3 w-3 shrink-0 text-success" />
              <span className="min-w-0 max-w-full truncate font-medium">{m.name}</span>
              <span className="text-2xs text-ink-faint">{gpuGuidance(m.sizeBytes, undefined, m)}</span>
              {m.modality && m.modality !== 'chat' && (
                        <span
                          className="chip shrink-0"
                          style={{ color: modalityTone(m.modality) }}
                          title={modalityTitle(m.modality)}
                        >
                          {MODALITY_LABELS[m.modality]}
                        </span>
                      )}
                      {m.format === 'mlx' && (
                        <span className="chip shrink-0" title="An MLX model folder, run by the MLX runtime on Apple Silicon">
                          MLX
                        </span>
                      )}
                      {m.modality === 'vision' && !m.hasProjector && (
                        <span className="chip shrink-0" style={{ color: 'var(--warning, #d1a054)' }} title="Its projector file (mmproj-*.gguf) is missing, so it answers text only">
                          no projector
                        </span>
                      )}
                      {m.loaded && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs text-white"
                          style={{ background: 'var(--success)' }}
                        >
                          <CheckIcon className="h-2.5 w-2.5" /> in memory
                        </span>
                      )}
                      {autoloadIds?.has(m.id) && (
                        <span className="chip shrink-0" title="Loads automatically when the engine starts">
                          on start
                        </span>
                      )}
                      {m.gpuFit === 'partial' && !unsupported && (
                        <span
                          className="chip shrink-0"
                          style={{ color: 'var(--warning, #d1a054)' }}
                          title="Under its saved settings, part of it runs on the CPU rather than fully in VRAM. Open Settings to change that."
                        >
                          part on CPU
                        </span>
                      )}
                      {m.gpuFit === 'wont' && !unsupported && (
                        <span
                          className="chip shrink-0"
                          style={{ color: 'var(--warning, #d1a054)' }}
                          title="The planner says it will not fit on this machine, even partly offloaded to the CPU."
                        >
                          won't fit
                        </span>
                      )}
                      {m.gpuFit === 'cpu' && !unsupported && (
                        <span className="chip shrink-0" title="No GPU to offload to, so it runs on the CPU">
                          CPU only
                        </span>
                      )}
                      {m.managed === false && (
                        <span className="chip shrink-0" title={`Read from ${m.path}`}>
                          {m.folderProvider ? MODEL_FOLDER_PROVIDERS[m.folderProvider].label : 'other folder'}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-2xs text-ink-faint">
                      {[
                        m.quantization,
                        m.parameterSize,
                        formatBytes(m.sizeBytes),
                        m.maxContext && `${formatTokens(m.maxContext)} max context`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="truncate font-mono text-2xs text-ink-faint" title={m.path}>
                      {m.path}
                    </p>
                  </div>

                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    {m.loaded && live?.loadedOn && (
                      <span className="text-2xs text-ink-faint" title={placementTitle(live)}>
                        {placementLabel(live)}
                      </span>
                    )}
                    {!unsupported && !m.loaded && (
                      <button
                        className="rounded-full border px-2 py-1 text-2xs"
                        style={{ borderColor: autoloadIds?.has(m.id) ? 'var(--accent)' : 'var(--line)' }}
                        title={
                          autoloadIds?.has(m.id)
                            ? 'Loads when the engine starts. Click to stop that.'
                            : running
                              ? 'Also load it when the engine starts'
                              : 'Load it automatically when the engine starts'
                        }
                        onClick={() => void toggleAutoload(m, !autoloadIds?.has(m.id))}
                      >
                        on start
                      </button>
                    )}
                    {!unsupported && (
                      <button
                        className="rounded-full border px-2 py-1 text-2xs hover:border-[var(--accent)]"
                        style={{ borderColor: open === m.id ? 'var(--accent)' : 'var(--line)' }}
                        onClick={() => setOpen(open === m.id ? null : m.id)}
                      >
                        {m.modality === 'image' ? 'Image settings' : 'Settings'}
                      </button>
                    )}
                    {unsupported ? null : m.loaded ? (
                      <button
                        className="rounded-full border px-2 py-1 text-2xs"
                        style={{ borderColor: 'var(--line)' }}
                        disabled={busy === m.id}
                        onClick={() => void unload(m.id)}
                      >
                        {busy === m.id ? 'unloading…' : 'Unload'}
                      </button>
                    ) : (
                      <button
                        className="rounded-full px-3 py-1 text-2xs text-white disabled:opacity-50"
                        style={{ background: 'var(--accent)' }}
                        title={canLoad ? `Load ${m.name} into memory` : 'Download the engine first'}
                        disabled={busy === m.id || (!canLoad && m.modality !== 'image')}
                        onClick={() => void quickLoad(m)}
                      >
                        {busy === m.id ? 'loading…' : 'Load'}
                      </button>
                    )}
                    {m.managed === false ? (
                      // The file belongs to whichever app downloaded it. Saying so
                      // beats a delete button that refuses after the click.
                      <span
                        className="px-2 text-2xs text-ink-faint"
                        title={`Delete this in ${m.folderProvider ? MODEL_FOLDER_PROVIDERS[m.folderProvider].label : 'the app that downloaded it'}`}
                      >
                        borrowed
                      </span>
                    ) : (
                      <button className="btn btn-ghost px-2 py-1" title="Delete this model" onClick={() => void remove(m)}>
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {unsupported && (
                  <p className="mt-1 flex items-start gap-2 px-3 text-2xs" style={{ color: 'var(--warning, #d1a054)' }}>
                    <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    {unsupported}
                  </p>
                )}
                {missingProjector && !unsupported && (
                  <p className="mt-1 flex flex-wrap items-center gap-2 px-3 text-2xs" style={{ color: 'var(--warning, #d1a054)' }}>
                    <WarningIcon className="h-3 w-3 shrink-0" />
                    Its projector (mmproj-*.gguf) is missing: it answers text but cannot see images.
                    <button
                      className="underline underline-offset-2 hover:text-ink"
                      disabled={busy === m.id}
                      onClick={() => void fetchCompanions(m)}
                    >
                      Fetch it now
                    </button>
                  </p>
                )}
                {m.lastLoadError && !m.loaded && (
                  <p className="mt-1 flex flex-wrap items-start gap-2 px-3 text-2xs" style={{ color: 'var(--danger, var(--warning, #d1a054))' }}>
                    <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>Last load failed: {m.lastLoadError}</span>
                    {missingProjector && (
                      <button
                        className="underline underline-offset-2 hover:text-ink"
                        disabled={busy === m.id}
                        onClick={() => void fetchCompanions(m)}
                      >
                        Fetch companion files
                      </button>
                    )}
                  </p>
                )}

                {open === m.id && m.modality === 'image' && <ImageGeneration model={m} onChanged={onChanged} />}
                {open === m.id && m.modality !== 'image' && (
                  <EngineLoadDrawer
                    providerId={providerId}
                    model={m}
                    loadedParams={residentById.get(m.id)?.params}
                    autoloaded={autoloadIds?.has(m.id) ?? false}
                    onToggleAutoload={(on) => void toggleAutoload(m, on)}
                    onFetchCompanions={() => void fetchCompanions(m)}
                    onDone={onChanged}
                    onClose={() => setOpen(null)}
                  />
                )}
              </div>
    );
  }
}

/** The group a model's folder belongs to, named for the app that fills it. */
function locationOf(m: LocalModel): string {
  return m.folderProvider
    ? MODEL_FOLDER_PROVIDERS[m.folderProvider].label
    : !m.folderId || m.folderId === 'primary'
      ? 'Nekko Agent'
      : 'Another folder';
}

/** One sentence for the badge tooltip: what the kind means for running it. */
function modalityTitle(modality: ModelModality): string {
  switch (modality) {
    case 'vision':
      return 'A chat model that can also read images, when its projector file is present';
    case 'embedding':
      return 'Turns text into vectors. Answers /v1/embeddings, not chat';
    case 'image':
      return 'An image-generation model. Runs in the optional stable-diffusion.cpp runtime';
    case 'audio':
      return 'A speech-recognition model. llama.cpp cannot serve it';
    case 'draft':
      return 'A speculative-decoding draft head. Only runs attached to its full model';
    case 'unknown':
      return 'The file would not parse as a GGUF';
    default:
      return 'A chat model';
  }
}

/**
 * Load with the planner's own answer at a middling budget.
 *
 * A model nobody has configured still has to load sensibly, and asking the same
 * planner the drawer asks means the quick path and the considered path cannot
 * disagree.
 */
async function autoLoad(providerId: string, modelId: string): Promise<{ ok: boolean; message?: string }> {
  const auto = await window.nekko.runtimeAutoFit(providerId, modelId, 0.75).catch(() => null);
  return window.nekko.runtimeLoad(providerId, modelId, {
    contextTokens: auto?.request.contextTokens,
    kvCacheDtype: auto?.request.kvCacheDtype,
    gpuLayers:
      auto?.plan.totalLayers && auto.request.gpuLayerFraction < 1
        ? Math.round(auto.plan.totalLayers * auto.request.gpuLayerFraction)
        : undefined,
  });
}
