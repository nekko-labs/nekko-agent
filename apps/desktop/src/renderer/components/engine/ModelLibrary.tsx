import { useMemo, useState } from 'react';
import { LIST_PAGE, pageGroups, showMoreLabel } from '../../listPaging.js';
import type { GpuFit, LocalModel, ModelModality, ResidentModel } from '@nekko-agent/shared';
import { MODALITY_LABELS, MODEL_FOLDER_PROVIDERS, unsupportedLoadReason } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { TrashIcon, WarningIcon } from '../../icons.js';
import { StatusDot } from '../primitives/index.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';
import { ImageGeneration } from './ImageGeneration.js';
import { gpuGuidance } from './modelFamilies.js';
import { MiddleTruncate } from '../primitives/MiddleTruncate.js';

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
  /** Rows rendered before "Show more"; a new search or filter starts over. */
  const [shown, setShown] = useState(LIST_PAGE);
  const [pagedFor, setPagedFor] = useState({ query, filter });
  if (pagedFor.query !== query || pagedFor.filter !== filter) {
    setPagedFor({ query, filter });
    setShown(LIST_PAGE);
  }

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

  /** The page of rows on screen: a big library does not mount every row. */
  const paged = useMemo(() => pageGroups(groups, shown), [groups, shown]);

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
        <div className="mt-(--q-inline) flex gap-2">
          <input
            className="quiet-field flex-1 font-mono text-xs"
            placeholder="C:\\models\\qwen2.5-7b-instruct-q4_k_m.gguf"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-ghost py-1 text-xs" onClick={runImport} disabled={!importPath.trim()}>
            Add
          </button>
        </div>
      )}

      {buckets.length > 2 && (
        <div className="mt-(--q-inline) flex flex-wrap gap-1" role="tablist" aria-label="Filter models">
          {buckets.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className="quiet-tab"
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      )}

      {!canLoad && models.length > 0 && (
        <p className="mt-(--q-inline) text-xs text-warning-text">
          These are on disk and ready. Download the engine above to run them here.
        </p>
      )}

      {models.length === 0 ? (
        <p className="mt-(--q-inline) text-xs text-ink-faint">
          Nothing here yet. Download one of the picks for this machine above or a model from the list, open{' '}
          <strong>Folders</strong> to point at a folder another app already fills, or add a GGUF you have.
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">
          Nothing on this machine matches {filter !== 'all' ? `${FILTER_LABELS[filter].toLowerCase()} models` : `"${query.trim()}"`}.
        </p>
      ) : (
        <div>
          {paged.groups.map(([loc, ms]) => (
            <div key={loc} className="mt-(--q-group) first:mt-(--q-inline)">
              {groups.length > 1 && (
                <p className="quiet-group-label mb-(--q-heading)">{loc}</p>
              )}
              <div className="-mx-2">{ms.map(renderRow)}</div>
            </div>
          ))}
          {paged.hidden > 0 && (
            <button
              type="button"
              data-model-library-more
              className="quiet-row mt-(--q-inline) text-xs text-ink-faint hover:text-ink"
              onClick={() => setShown((n) => n + LIST_PAGE)}
            >
              {showMoreLabel(paged.hidden)}
            </button>
          )}
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
          className="flex min-h-(--q-row) flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-xs transition-colors duration-(--dur-fast) hover:bg-(--q-wash)"
          style={{ opacity: unsupported ? 0.85 : 1, background: m.loaded ? 'var(--accent-soft)' : undefined }}
          data-quiet-row
        >
          <div className="min-w-48 flex-1" title={m.path}>
            <MiddleTruncate text={m.name} tail={20} className="block max-w-full text-sm font-medium" />
            <p className="truncate text-2xs text-ink-faint" title={m.modality && m.modality !== 'chat' ? modalityTitle(m.modality) : undefined}>
              {[
                gpuGuidance(m.sizeBytes, undefined, m),
                m.quantization,
                m.parameterSize,
                formatBytes(m.sizeBytes),
                m.maxContext && `${formatTokens(m.maxContext)} max context`,
                m.modality && m.modality !== 'chat' && MODALITY_LABELS[m.modality],
                m.format === 'mlx' && 'MLX',
                autoloadIds?.has(m.id) && 'loads on start',
                m.gpuFit === 'cpu' && !unsupported && 'CPU only',
                m.managed === false && `from ${m.folderProvider ? MODEL_FOLDER_PROVIDERS[m.folderProvider].label : 'another folder'}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {m.loaded ? (
              <span className="mr-1 inline-flex items-center gap-1.5 text-2xs text-ink-soft" title={live ? placementTitle(live) : undefined}>
                <StatusDot color="var(--accent)" size={6} />
                In memory{live?.loadedOn ? ` · ${placementLabel(live)}` : ''}
              </span>
            ) : missingProjector ? (
              <span className="mr-1 inline-flex items-center gap-1.5 text-2xs text-warning-text" title="Its projector file (mmproj-*.gguf) is missing, so it answers text only">
                <StatusDot tone="warning" size={6} />
                No projector
              </span>
            ) : !unsupported && (m.gpuFit === 'partial' || m.gpuFit === 'wont') ? (
              <span
                className="mr-1 inline-flex items-center gap-1.5 text-2xs text-warning-text"
                title={m.gpuFit === 'partial'
                  ? 'Under its saved settings, part of it runs on the CPU rather than fully in VRAM. Open Settings to change that.'
                  : 'The planner says it will not fit on this machine, even partly offloaded to the CPU.'}
              >
                <StatusDot tone="warning" size={6} />
                {m.gpuFit === 'partial' ? 'Part on CPU' : 'Won’t fit'}
              </span>
            ) : null}
            {!unsupported && !m.loaded && (
              <button
                className={`btn btn-ghost quiet-row-action min-h-8! px-2 py-1 touch:min-h-11! text-2xs ${autoloadIds?.has(m.id) ? 'text-accent' : ''}`}
                aria-pressed={!!autoloadIds?.has(m.id)}
                title={
                  autoloadIds?.has(m.id)
                    ? 'Loads when the engine starts. Click to stop that.'
                    : running
                      ? 'Also load it when the engine starts'
                      : 'Load it automatically when the engine starts'
                }
                onClick={() => void toggleAutoload(m, !autoloadIds?.has(m.id))}
              >
                On start
              </button>
            )}
            {!unsupported && (
              <button
                className={`btn btn-ghost quiet-row-action min-h-8! px-2 py-1 touch:min-h-11! text-2xs ${open === m.id ? 'text-accent' : ''}`}
                aria-expanded={open === m.id}
                onClick={() => setOpen(open === m.id ? null : m.id)}
              >
                {m.modality === 'image' ? 'Image settings' : 'Settings'}
              </button>
            )}
            {unsupported ? null : m.loaded ? (
              <button className="btn btn-ghost quiet-row-action min-h-8! px-2 py-1 touch:min-h-11! text-2xs" disabled={busy === m.id} onClick={() => void unload(m.id)}>
                {busy === m.id ? 'Unloading…' : 'Unload'}
              </button>
            ) : (
              <button
                className="btn btn-ghost min-h-8! px-2 py-1 text-2xs font-medium text-accent touch:min-h-11! disabled:opacity-50"
                title={canLoad ? `Load ${m.name} into memory` : 'Download the engine first'}
                disabled={busy === m.id || (!canLoad && m.modality !== 'image')}
                onClick={() => void quickLoad(m)}
              >
                {busy === m.id ? 'Loading…' : 'Load'}
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
              <button className="btn btn-ghost quiet-row-action min-h-8! px-2 py-1 touch:min-h-11!" title="Delete this model" aria-label="Delete this model" onClick={() => void remove(m)}>
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

                {unsupported && (
                  <p className="mt-(--q-tight) flex items-start gap-2 px-2 text-2xs text-warning-text">
                    <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    {unsupported}
                  </p>
                )}
                {missingProjector && !unsupported && (
                  <p className="mt-(--q-tight) flex flex-wrap items-center gap-2 px-2 text-2xs text-warning-text">
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
                  <p className="mt-(--q-tight) flex flex-wrap items-start gap-2 px-2 text-2xs text-danger-text">
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
