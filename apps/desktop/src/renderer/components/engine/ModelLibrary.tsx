import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { LIST_PAGE, pageGroups, showMoreLabel } from '../../listPaging.js';
import type { EngineMemory, LocalModel, ModelModality, ResidentModel } from '@nekko-agent/shared';
import { MODEL_FOLDER_PROVIDERS, cannotLoadReason } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { notifyModelsChanged } from '../../modelCatalog.js';
import { CheckIcon, ChevronIcon, WarningIcon } from '../../icons.js';
import { StatusDot, Toggle } from '../primitives/index.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';
import { ImageGeneration } from './ImageGeneration.js';
import { ModelMemoryPreview } from './ModelMemoryPreview.js';
import { loadLocalModel } from './localModelShortcuts.js';
import { gpuGuidance, sortLibraryModels, type LibraryModel, type ModelSort } from './modelFamilies.js';
import { ModelRowActions, type ModelRowControl } from './ModelRowActions.js';
import { RunnableAlternativeOffer } from './RunnableAlternativeOffer.js';
import { loadableFiles } from './runnableAlternative.js';
import { localTypeLabel, modelProblem, paramsLabel } from './modelFacts.js';
import { MiddleTruncate } from '../primitives/MiddleTruncate.js';

/**
 * The models on this machine.
 *
 * A row is a whole model's state in one line: what it is, what kind of model it
 * is, what it takes to load, whether it is in memory, and the one action
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
  actions,
  query = '',
  autoloadIds,
  resident,
  sortBy,
  memory,
}: {
  providerId: string;
  models: LibraryModel[];
  /** The GPU's size, so a model the busy GPU cannot hold now is not called too big. */
  memory?: EngineMemory;
  /** The engine's resident list, for where each loaded model actually sits. */
  resident?: ResidentModel[];
  /** False until the engine binary exists: the list is real, running it is not. */
  canLoad: boolean;
  onChanged: () => void;
  actions: ModelRowControl;
  /** Live filter from the shared search box (matches name, id, quant, folder). */
  query?: string;
  /** Ids marked to load when the engine starts. */
  autoloadIds?: Set<string>;
  /** The installed-library order selected by the Models page. */
  sortBy?: ModelSort;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const settingsId = useId();
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
    const req = loadLocalModel(providerId, model);
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
    try {
      await window.nekko.engineSetAutoload(model.id, on);
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : "Couldn't change startup loading.");
      return;
    }
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

  const orderedModels = useMemo(() => sortBy ? sortLibraryModels(models, sortBy) : models, [models, sortBy]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orderedModels;
    return orderedModels.filter((m) =>
      [m.name, m.id, m.quantization, m.parameterSize, m.sourceRepo, m.folderProvider]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [orderedModels, query]);

  const visible = useMemo(
    () => (filter === 'all' ? searched : searched.filter((m) => bucketOf(m.modality) === filter)),
    [searched, filter],
  );

  /**
   * The list groups by where each model lives: our own downloads first, then
   * the other apps' folders alphabetically. Headers only print when there is
   * more than one group to name. An installed sort orders across folders.
   */
  const groups = useMemo((): [string, LibraryModel[]][] => {
    if (sortBy) return [['', visible]];
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
  }, [visible, sortBy]);

  /** The files already here, so a row's offer never suggests one the family has. */
  const haveFiles = useMemo(() => loadableFiles(models), [models]);

  /** The page of rows on screen: a big library does not mount every row. */
  const paged = useMemo(() => pageGroups(groups, shown), [groups, shown]);

  /** Residency, by model id: where a loaded model actually sits. */
  const residentById = useMemo(() => new Map((resident ?? []).map((r) => [r.id, r])), [resident]);

  // Another surface (the Local models monitor's starred and recent rows) asked
  // for a model that is not in memory: the In memory list cannot serve that, so
  // this list unfolds the row's settings, shows every row, and scrolls to it.
  const focus = useStore((s) => s.localModelFocus);
  const clearFocus = useStore((s) => s.clearLocalModelFocus);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = focus ? models.find((m) => m.id === focus) : undefined;
    if (!target || target.loaded) return;
    setFilter('all');
    setShown(Math.max(LIST_PAGE, models.length));
    setOpen(target.id);
    clearFocus();
    requestAnimationFrame(() => rootRef.current?.querySelector(`[data-library-row="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [focus, models, clearFocus]);

  const runImport = async () => {
    const path = importPath.trim();
    if (!path) return;
    const res = await window.nekko.engineImportModel(path);
    pushToast(res.ok ? 'success' : 'error', res.message);
    if (res.ok) {
      setImportPath('');
      setImporting(false);
      onChanged();
      notifyModelsChanged();
    }
  };

  return (
    <div ref={rootRef}>
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
          Nothing here yet. Get one under <strong>Find new models</strong>, open <strong>Folders</strong> to point at a
          folder another app already fills, or add a GGUF you have.
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
    const unsupported = m.modality === 'image' ? undefined : cannotLoadReason(m);
    const missingProjector = m.modality === 'vision' && !m.hasProjector;
    const live = residentById.get(m.id);
    const problem = modelProblem(m);
    const fit = gpuGuidance(m.sizeBytes, memory, m);
    const expanded = !unsupported && open === m.id;
    const panelId = `${settingsId}-${m.id}`;
    const previewId = `${panelId}-memory`;
    const details = (
      <span className="block min-w-0 flex-1">
        <MiddleTruncate text={m.name} tail={20} className="block max-w-full text-sm font-medium" />
        <ModelMemoryPreview model={m} memory={memory} id={previewId} />
        {actions.isDefault(m) && <span className="text-2xs text-accent">Default</span>}
        <span className="block text-xs text-ink-soft" data-model-facts>{[localTypeLabel(m), paramsLabel(m.name, m.parameterSize)].filter(Boolean).join(' · ')}</span>
        <span className="block text-2xs text-ink-faint" title={m.modality && m.modality !== 'chat' ? modalityTitle(m.modality) : undefined}>
          {[
            fit,
            m.quantization,
            m.maxContext && `${formatTokens(m.maxContext)} max context`,
            m.format === 'mlx' && 'MLX',
            m.managed === false && `from ${locationOf(m)}`,
          ].filter(Boolean).join(' · ')}
        </span>
      </span>
    );
    return (
      <div key={m.id} data-library-row={m.id} className="model-library-card scroll-mt-4" data-expanded={expanded}>
        <div
          className="model-library-card__head relative flex min-h-(--q-row) flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-xs transition-colors duration-(--dur-fast) hover:bg-(--q-wash)"
          style={{ opacity: unsupported ? 0.85 : 1, background: m.loaded ? 'var(--accent-soft)' : undefined }}
          data-quiet-row
        >
          {unsupported ? (
            <div className="min-w-0 flex-[1_1_12rem]" title={m.path}>{details}</div>
          ) : (
            <button
              type="button"
              className="flex min-h-8 min-w-0 flex-[1_1_12rem] items-center gap-2 rounded text-left"
              title={m.path}
              aria-label={`${m.modality === 'image' ? 'Image settings' : 'Settings'} for ${m.name}`}
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-describedby={previewId}
              data-model-row-toggle
              onClick={() => setOpen(expanded ? null : m.id)}
            >
              {details}
              <span aria-hidden="true" className="shrink-0 text-ink-faint">
                <ChevronIcon className={`h-4 w-4 transition-transform duration-(--dur-fast) motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
              </span>
            </button>
          )}

          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
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
            ) : !problem && (m.gpuFit === 'full' || m.gpuFit === 'cpu' || m.gpuFit === 'partial' || m.gpuFit === 'wont') ? (
              <span className={`mr-1 shrink-0 ${m.gpuFit === 'full' || m.gpuFit === 'cpu' ? 'text-success' : 'text-warning-text'}`} aria-hidden="true" title={fit} data-model-fit={m.gpuFit}>
                {m.gpuFit === 'full' || m.gpuFit === 'cpu' ? <CheckIcon className="h-3.5 w-3.5" /> : <WarningIcon className="h-3.5 w-3.5" />}
              </span>
            ) : null}
            <ModelRowActions model={m} actions={actions} />
            {unsupported ? null : m.loaded ? (
              <button className="btn btn-outline ml-1 min-h-8! px-3 py-1 text-xs touch:min-h-11!" disabled={busy === m.id} onClick={() => void unload(m.id)}>
                {busy === m.id ? 'Unloading…' : 'Unload'}
              </button>
            ) : (
              <button
                className="btn btn-primary ml-1 min-h-8! min-w-16 px-3 py-1 text-xs touch:min-h-11!"
                title={canLoad ? `Load ${m.name} into memory` : 'Download the engine first'}
                disabled={busy === m.id || (!canLoad && m.modality !== 'image')}
                onClick={() => void quickLoad(m)}
              >
                {busy === m.id ? 'Loading…' : 'Load'}
              </button>
            )}
          </div>
        </div>

        {!unsupported && (
          <ModelSettingsReveal id={panelId} open={expanded}>
            {autoloadIds && <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium">Load when the engine starts</p>
                <p className="text-2xs text-ink-faint">Uses this model’s saved settings.</p>
              </div>
              <Toggle value={autoloadIds.has(m.id)} onChange={(on) => void toggleAutoload(m, on)} label="Load when the engine starts" />
            </div>}
            {m.modality === 'image' ? <ImageGeneration model={m} onChanged={onChanged} attached /> : (
              <EngineLoadDrawer
                providerId={providerId}
                model={m}
                loadedParams={live?.params}
                attached
                onFetchCompanions={() => void fetchCompanions(m)}
                onDone={onChanged}
                onClose={() => {
                  setOpen(null);
                  rootRef.current?.querySelector<HTMLButtonElement>(`[data-library-row="${CSS.escape(m.id)}"] [data-model-row-toggle]`)?.focus();
                }}
              />
            )}
          </ModelSettingsReveal>
        )}

        {unsupported && (
          <p className="mt-(--q-tight) flex items-start gap-2 px-2 text-2xs text-warning-text">
            <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
            {unsupported}
          </p>
        )}
        {unsupported && <RunnableAlternativeOffer model={m} have={haveFiles} onChanged={onChanged} />}
        {!unsupported && m.loadCheck?.level === 'warning' && (
          <p className="mt-(--q-tight) flex items-start gap-2 px-2 text-2xs text-warning-text" data-model-load-warning>
            <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
            {m.loadCheck.reason}
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
      </div>
    );
  }
}

/** Keep the closing contents only long enough for the panel to slide shut. */
function ModelSettingsReveal({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) setRetained(true);
    else if (retained && matchMedia('(prefers-reduced-motion: reduce)').matches) setRetained(false);
    else if (retained) {
      // Fallback for an interrupted or offscreen transition that doesn't fire an end event.
      const timeout = setTimeout(() => setRetained(false), 300);
      return () => clearTimeout(timeout);
    }
  }, [open, retained]);
  return (
    <div id={id} className="model-library-card__reveal" inert={!open}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows' && !open) setRetained(false);
      }}>
      <div className="model-library-card__clip">
        {(open || retained) && <div className="model-library-card__details">{children}</div>}
      </div>
    </div>
  );
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
