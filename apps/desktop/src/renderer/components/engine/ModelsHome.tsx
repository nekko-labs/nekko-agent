import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CatalogModel, EngineMemory, EngineSettings, ImageRecommendedOption, Recommendations, ResidentModel } from '@nekko-agent/shared';
import { ModelLibrary } from './ModelLibrary.js';
import { ModelDetail } from './ModelDetail.js';
import { RecommendedModels, imageFitText } from './RecommendedModels.js';
import { CheckIcon, ChevronIcon, ListIcon, WarningIcon } from '../../icons.js';
import { StatusDot } from '../primitives/index.js';
import { familyKind, groupModelFamilies, gpuGuidance, modelFamilyName, MODEL_SORT_LABELS, setUpPictureModels, shelveCatalog, smallestVariant, sortModelFamilies, type FamilyKind, type LibraryModel, type ModelFamily, type ModelSort } from './modelFamilies.js';
import { ModelRowActions, useModelRowActions } from './ModelRowActions.js';
import { pictureModelBlurb, pictureTimeText } from './pictureModelText.js';
import { useStore } from '../../store.js';
import { formatBytes } from '../runtimes/verdict.js';
import { familyProblem, localTypeLabel, paramsLabel, paramsText, sizeRangeText } from './modelFacts.js';
import { ModelGpuFacts } from './ModelGpuFacts.js';

/**
 * Models, in two halves the switch above them picks between.
 *
 * **On this machine** is what is downloaded: a filter (never a web search),
 * the families on disk, and for the one selected its variants, what it needs
 * on the GPU and how much context fits. A model with a problem (its last load
 * failed, it cannot run here, its projector is missing) wears a warning on its
 * row, never the check a healthy one would.
 *
 * **Find new models** is getting one: the picks for this machine lead until
 * a search starts, then the search covers Hugging Face. Models already on disk
 * still appear there with a check, so "do I have qwen" has one answer.
 *
 * One search box used to cover both, with installed and downloadable rows in
 * one scroll; that answered "do I have it" well and "what should I get" badly,
 * because the picks were folded above a list that was mostly the library.
 *
 * Picture and video models are held to a shorter list than chat ones. A chat
 * GGUF is one file that starts; a picture model also needs a text encoder and
 * a VAE, so only the ones Nekko has set up are listed, and what else a search
 * finds from known publishers waits behind "Show more from Hugging Face".
 */
export type ModelsMode = 'installed' | 'find';

/** The kind filter above the list: what a model makes. */
export const KIND_FILTERS: { id: 'all' | FamilyKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'image', label: 'Pictures' },
  { id: 'video', label: 'Video' },
];

/** One line under the filter when it needs saying: what the list can and cannot do for that kind. */
export function kindNote(kind: 'all' | FamilyKind, query: string, shown: number): string | null {
  if (kind === 'video') return 'Wan 2.2 TI2V 5B makes short clips in a Photo chat (experimental, needs a graphics card).';
  if (kind === 'image' && !query.trim() && !shown) return 'No picture models here yet. Download one of the picks above, or search Hugging Face.';
  return null;
}

/** The fit line of a set-up picture model: the recommendation's own answer, not the chat estimate from file size. */
export function setUpFitText(o: ImageRecommendedOption): string {
  return o.fit === 'tooBig' ? 'Too large for this computer' : imageFitText(o).text;
}

/** The set-up model a family holds, if any: the list then says its name and what it is for, not a repository's. */
export function setUpModelOf(f: ModelFamily, picks: ImageRecommendedOption[]): ImageRecommendedOption | undefined {
  return picks.find(p => f.catalog.some(m => m.id === p.repo) || f.local.some(m => m.sourceRepo === p.repo));
}

/** The families a search found that Nekko has not set up: nothing on disk, and every source from the "more" shelf. */
export function isMoreFamily(f: ModelFamily, more: Set<string>): boolean {
  return !f.local.length && f.catalog.length > 0 && f.catalog.every(m => more.has(m.id));
}

/** The families each half lists: what is on disk, or what can be downloaded. */
export function familiesFor(mode: ModelsMode, families: ModelFamily[]): ModelFamily[] {
  return families.filter(f => (mode === 'installed' ? f.local.length > 0 : f.catalog.length > 0));
}

/** The second line of a family's row: its problem when it has one, else its size, its parameters and whether it fits. */
export function familyLine(f: ModelFamily, mode: ModelsMode, memory: EngineMemory | undefined, setUp?: ImageRecommendedOption): { text: string; tone: 'danger' | 'warning' | 'faint'; title?: string } {
  const problem = mode === 'installed' ? familyProblem(f.local) : null;
  if (problem) return { text: problem.text, tone: problem.tone, title: problem.detail };
  if (setUp) {
    const time = pictureTimeText(setUp);
    return { text: [pictureModelBlurb(setUp), f.local.length ? null : setUpFitText(setUp), time?.text].filter(Boolean).join(' · '), tone: 'faint', title: time?.title };
  }
  const smallest = smallestVariant(f.local);
  const params = paramsText(f.name, smallest?.parameterSize ?? f.catalog.find(m => m.parameterSize)?.parameterSize);
  if (mode === 'installed' && smallest) {
    const loaded = f.local.some(m => m.loaded);
    const size = f.local.length > 1 ? `${f.local.length} variants, ${sizeRangeText(f.local.map(m => m.sizeBytes))}` : formatBytes(smallest.sizeBytes);
    const fit = loaded ? 'in memory' : gpuGuidance(smallest.sizeBytes, memory, smallest);
    return { text: [params, size, fit].filter(Boolean).join(' · '), tone: !loaded && (smallest.gpuFit === 'partial' || smallest.gpuFit === 'wont') ? 'warning' : 'faint', title: 'Planner result for the smallest downloaded variant' };
  }
  const sizes = f.catalog.flatMap(m => m.quants.map(q => q.sizeBytes ?? 0)).filter(Boolean);
  const quants = f.catalog.reduce((n, m) => n + m.quants.length, 0);
  const fit = gpuGuidance(sizes.length ? Math.min(...sizes) : undefined, memory);
  const estimated = memory?.kind !== 'ram' && fit !== 'GPU fit unknown' ? ' (estimated)' : '';
  const range = sizeRangeText(sizes);
  return {
    text: [params, quants ? `${quants} quant${quants === 1 ? '' : 's'}${range ? `, ${range}` : ''}` : null, `${fit.replace(/^Fits/, 'smallest fits')}${estimated}`].filter(Boolean).join(' · '),
    tone: 'faint',
    title: 'Estimate from file size, not a measured context limit',
  };
}

/** The names of the models in memory other than `selfId`, as the library reads them. */
export function residentNames(resident: ResidentModel[], models: LibraryModel[], selfId: string): string[] {
  return resident.filter(r => r.id !== selfId).map(r => modelFamilyName(models.find(m => m.id === r.id)?.name ?? r.id));
}

const LINE_TONE ={ danger: 'text-danger-text', warning: 'text-warning-text', faint: 'text-ink-faint' } as const;

export function ModelsHome({
  providerId,
  mode,
  models,
  canLoad,
  memory,
  resident,
  settings,
  onChanged,
  onFind,
  mlx = false,
}: {
  providerId: string;
  /** Which half of the page this is: what is on disk, or finding something new. */
  mode: ModelsMode;
  models: LibraryModel[];
  canLoad: boolean;
  memory?: EngineMemory;
  /** The models actually in memory right now, for where each loaded variant sits. */
  resident: ResidentModel[];
  settings: EngineSettings;
  onChanged: () => void;
  onOpenModel?: (id: string) => void;
  /** Switch to Find new models, from the empty library. */
  onFind?: () => void;
  /** An Apple Silicon Mac, where the catalog also offers MLX checkpoints. */
  mlx?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [format, setFormat] = useState<'gguf' | 'mlx'>('gguf');
  const [kind, setKind] = useState<'all' | FamilyKind>('all');
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [sortBy, setSortBy] = useState<ModelSort>('recent');
  const detailId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // Each half keeps nothing of the other's search: a filter of the library is not a web search.
  useEffect(() => { setQuery(''); setSelectedKey(null); setShowMore(false); }, [mode]);

  useEffect(() => {
    let live = true;
    window.nekko.machineRecommendations().then(r => { if (live) setRecs(r); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  // Only Find searches Hugging Face. The library still reads the starter
  // catalog, so a model on disk can offer its other quants.
  const webQuery = mode === 'find' ? query.trim() : '';
  useEffect(() => {
    let live = true;
    setSearching(true);
    setError('');
    const timer = setTimeout(() => {
      window.nekko.engineCatalog(webQuery || undefined, format).then((next) => {
        if (live) setCatalog(next);
      }).catch(() => {
        if (live) { setCatalog([]); setError('Catalog unavailable. Your downloaded models are still here.'); }
      }).finally(() => { if (live) setSearching(false); });
    }, webQuery ? 350 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [webQuery, format]);

  // A jump to one model's settings from elsewhere: when it is not in memory its
  // drawer lives in its family's variant list, so that family is selected and
  // any search or kind filter that would hide it is cleared. ModelLibrary then
  // opens the row and clears the request.
  const focus = useStore((s) => s.localModelFocus);
  const focusLoaded = !!focus && resident.some((r) => r.id === focus);
  const picks = useMemo(() => setUpPictureModels(recs), [recs]);
  // The starter list stays chat only: the picks join it under Pictures or Video, or once there is a search.
  const shelves = useMemo(() => shelveCatalog(catalog, picks, models, kind !== 'all' || !!webQuery), [catalog, picks, models, kind, webQuery]);
  const families = useMemo(() => {
    const grouped = familiesFor(mode, groupModelFamilies(models, [...shelves.listed, ...shelves.more]));
    return mode === 'installed' ? sortModelFamilies(grouped, sortBy) : grouped;
  }, [models, shelves, mode, sortBy]);
  const matching = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return families.filter(f => (kind === 'all' || familyKind(f) === kind) && words.every(word => [f.name, ...f.local.flatMap(m => [m.name, m.sourceRepo, m.quantization, m.folderProvider]), ...f.catalog.flatMap(m => [m.name, m.id, ...m.tags])].join(' ').toLowerCase().includes(word)));
  }, [families, query, kind]);
  useEffect(() => {
    if (!focus || focusLoaded || mode !== 'installed') return;
    const family = families.find(f => f.local.some(m => m.id === focus));
    if (!family) return;
    setQuery('');
    setKind('all');
    setSelectedKey(family.key);
    setRepoId(null);
  }, [focus, focusLoaded, families, mode]);
  const moreIds = useMemo(() => new Set(shelves.more.map(m => m.id)), [shelves]);
  const extra = useMemo(() => matching.filter(f => isMoreFamily(f, moreIds)), [matching, moreIds]);
  const main = useMemo(() => matching.filter(f => !extra.includes(f)), [matching, extra]);
  const visible = showMore ? [...main, ...extra] : main;
  const note = kindNote(kind, query, visible.length + extra.length);
  const selected = visible.find(f => f.key === selectedKey) ?? (mode === 'find' ? visible[0] : undefined);
  const selectFamily = (key: string | null) => { setSelectedKey(key); setRepoId(null); };
  const repositories = [...new Set([...(selected?.catalog.map(m => m.id) ?? []), ...(selected?.local.map(m => m.sourceRepo).filter((id): id is string => Boolean(id)) ?? [])])];
  const selectedRepo = repositories.includes(repoId ?? '') ? repoId! : repositories[0];
  const residentById = useMemo(() => new Map(resident.map(r => [r.id, r])), [resident]);

  const actions = useModelRowActions(providerId, onChanged);
  const row = (f: ModelFamily) => {
    const setUp = setUpModelOf(f, picks);
    const line = familyLine(f, mode, memory, setUp);
    const problem = mode === 'installed' ? familyProblem(f.local) : null;
    const loaded = f.local.some(m => m.loaded);
    const on = selected?.key === f.key;
    const single = mode === 'installed' && f.local.length === 1 ? f.local[0] : undefined;
    const installed = mode === 'installed';
    const types = installed ? [...new Set(f.local.map(localTypeLabel))] : [];
    const type = familyKind(f) === 'video' ? 'Video generation' : types.length === 1 ? types[0] : 'Mixed types';
    const facts = installed && [type, paramsLabel(f.name, f.local.find(m => m.parameterSize)?.parameterSize), sizeRangeText(f.local.map(m => m.sizeBytes).filter(n => n > 0))].filter(Boolean).join(' · ');
    const smallest = installed ? smallestVariant(f.local) : undefined;
    const selectedClass = on ? 'bg-accent-soft' : 'hover:bg-(--q-wash)';
    const control = <button key={f.key} type="button" data-model-family={f.key} className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-(--q-inline) text-left ${installed ? 'w-full' : `-mx-2 w-[calc(100%+16px)] ${selectedClass}`}`} aria-pressed={installed ? undefined : on} aria-expanded={installed ? on : undefined} aria-controls={installed ? detailId : undefined} onClick={() => selectFamily(installed && on ? null : f.key)}>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium">{setUp?.name ?? f.name}{installed && f.local.some(actions.isDefault) && <span className="ml-2 text-2xs text-accent">Default</span>}</span>
        {facts && <span className="mt-(--q-tight) block text-xs text-ink-soft" data-model-facts>{facts.replace(/(\d) (GB|MB|KB|B)\b/g, '$1\u00a0$2')}</span>}
        <span className={`block ${facts ? 'mt-0.5' : 'mt-(--q-tight)'} text-xs ${LINE_TONE[line.tone]}`} title={line.title} data-model-line>{installed && !problem ? (loaded ? 'In memory' : gpuGuidance(smallest?.sizeBytes, memory, smallest)) : line.text}</span>
      </span>
      {problem ? (
        <span className={`shrink-0 ${problem.tone === 'danger' ? 'text-danger' : 'text-warning'}`} role="img" aria-label={`${problem.text}: ${problem.detail}`} title={problem.detail} data-family-problem><WarningIcon className="h-4 w-4" /></span>
      ) : loaded ? (
        <span className="shrink-0" role="img" aria-label="In memory" title="In memory"><StatusDot tone="success" size={6} /></span>
      ) : mode === 'find' && f.local.length > 0 ? (
        <span className="shrink-0 text-success" role="img" aria-label="Downloaded" title="Downloaded"><CheckIcon className="h-4 w-4" /></span>
      ) : installed && smallest && (smallest.gpuFit === 'partial' || smallest.gpuFit === 'wont') ? (
        <span className="shrink-0 text-warning-text" aria-hidden="true" title={line.title} data-model-fit={smallest.gpuFit}><WarningIcon className="h-4 w-4" /></span>
      ) : installed && smallest && (smallest.gpuFit === 'full' || smallest.gpuFit === 'cpu') ? (
        <span className="shrink-0 text-success" aria-hidden="true" title={line.title} data-model-fit={smallest.gpuFit}><CheckIcon className="h-4 w-4" /></span>
      ) : null}
      {installed && <ChevronIcon className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-(--dur-fast) motion-reduce:transition-none ${on ? 'rotate-90' : ''}`} aria-hidden="true" />}
    </button>;
    return installed ? <div key={f.key} className={`-mx-2 flex items-center rounded-lg pr-1 transition-colors duration-(--dur-fast) ${selectedClass}`}>
      <div className="min-w-0 flex-1">{control}</div>
      {single && <ModelRowActions model={single} label={setUp?.name ?? f.name} actions={actions} />}
      {!single && <span className="shrink-0 pr-2 text-2xs text-ink-faint">{f.local.length} variants</span>}
    </div> : control;
  };

  const emptyLibrary = mode === 'installed' && models.length === 0;
  const firstVariant = selected?.local.slice().sort((a, b) => Number(b.loaded) - Number(a.loaded) || b.sizeBytes - a.sizeBytes)[0];

  return (
    <>
    {mode === 'find' && !query.trim() && <div className="mb-(--q-section)"><RecommendedModels models={models} onQueued={onChanged} /></div>}
    {mode === 'installed' && <RecommendedModels models={models} onQueued={onChanged} nudgesOnly />}
    {emptyLibrary ? (
      <div data-empty-library>
        {onFind && <button type="button" className="btn btn-primary mb-(--q-inline) py-1 text-xs" onClick={onFind}>Find a model for this machine</button>}
        <ModelLibrary providerId={providerId} models={[]} actions={actions} canLoad={canLoad} onChanged={onChanged} />
      </div>
    ) : (
    <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
      <div className="min-w-0">
        <input className="quiet-field w-full text-xs" aria-label={mode === 'find' ? 'Search models' : 'Filter my models'} placeholder={mode === 'find' ? 'Search models and Hugging Face' : 'Filter my models'} value={query} onChange={e => setQuery(e.target.value)} spellCheck={false} />
        <div className="mt-(--q-inline)"><KindFilter kind={kind} onChange={k => { setKind(k); setSelectedKey(null); }} /></div>
        {note && <p role="status" className="mt-(--q-inline) text-xs text-ink-soft" data-kind-note>{note}</p>}
        {mlx && mode === 'find' && <select className="quiet-field mt-(--q-inline) text-xs" aria-label="Catalog format" value={format} onChange={e => setFormat(e.target.value as 'gguf' | 'mlx')}><option value="gguf">GGUF</option><option value="mlx">MLX</option></select>}
        <div className="mt-(--q-inline) flex items-center justify-between gap-3">
          <p className="text-xs text-ink-faint">{mode === 'find' ? `${searching ? 'Searching…' : `${visible.length} models`} · Checkmarks mean downloaded` : `${visible.length} model${visible.length === 1 ? '' : 's'} on this machine`}</p>
          {mode === 'installed' && <ModelSortSelect value={sortBy} onChange={setSortBy} />}
        </div>
        {error && mode === 'find' && <p role="status" className="mt-(--q-inline) text-xs text-ink-faint">{error}</p>}
        <div ref={listRef} className="mt-(--q-inline) max-h-[65vh] overflow-y-auto px-2" aria-label="Models">
          {main.map(row)}
          {extra.length > 0 && <button type="button" className="btn btn-ghost mt-2 text-xs" aria-expanded={showMore} data-more-models onClick={() => setShowMore(v => !v)}>{showMore ? 'Hide' : 'Show'} {extra.length} more from Hugging Face</button>}
          {showMore && extra.length > 0 && <p className="py-1 text-xs text-ink-faint" data-more-note>Not set up by Nekko. These may need extra files, or not start.</p>}
          {showMore && extra.map(row)}
          {!searching && !visible.length && !extra.length && !note && <p className="py-4 text-xs text-ink-faint">{mode === 'find' ? 'No matching models. Try a shorter search.' : 'Nothing on this machine matches. Try Find new models.'}</p>}
        </div>
      </div>
      <div id={detailId} className="min-w-0" aria-label="Model details">
        {selected ? <>
          <h3 className="break-words text-xl font-semibold">
            {mode === 'installed' ? (
              <button type="button" data-model-family-header aria-expanded="true" className="inline-flex max-w-full items-center gap-1 text-left hover:text-accent" onClick={() => {
                selectFamily(null);
                listRef.current?.querySelector<HTMLButtonElement>(`[data-model-family="${CSS.escape(selected.key)}"]`)?.focus();
              }}>
                <span aria-hidden="true"><ChevronIcon className="h-4 w-4 shrink-0 rotate-90 text-ink-faint" /></span>
                <span className="min-w-0">{setUpModelOf(selected, picks)?.name ?? selected.name}</span>
              </button>
            ) : setUpModelOf(selected, picks)?.name ?? selected.name}
          </h3>
          <p className="mt-(--q-tight) text-xs text-ink-faint" data-family-summary>
            {[paramsLabel(selected.name, firstVariant?.parameterSize ?? selected.catalog.find(m => m.parameterSize)?.parameterSize),
              selected.local.length ? `${selected.local.length} variant${selected.local.length === 1 ? '' : 's'} on this machine, ${formatBytes(selected.local.reduce((n, m) => n + m.sizeBytes, 0))}` : 'Not downloaded yet',
            ].filter(Boolean).join(' · ')}
          </p>
          {selected.local.length > 0 && <>
            <h4 className="mt-(--q-group) quiet-group-label">Variants on this machine</h4>
            <div className="mt-(--q-heading)"><ModelLibrary key={selected.key} providerId={providerId} models={selected.local} actions={actions} resident={resident} memory={memory} canLoad={canLoad} onChanged={onChanged} autoloadIds={new Set(settings.autoload ?? [])} sortBy={mode === 'installed' ? sortBy : undefined} /></div>
            {firstVariant && <ModelGpuFacts key={firstVariant.id} providerId={providerId} model={firstVariant} resident={residentById.get(firstVariant.id)} others={residentNames(resident, models, firstVariant.id)} />}
          </>}
          {repositories.length > 0 && <div className="mt-(--q-group)"><label className="block text-xs text-ink-faint" htmlFor="model-source">{selected.local.length ? 'Other builds from' : 'Variant provider / repository'}</label><select id="model-source" className="quiet-field mt-(--q-tight) w-full text-xs" value={selectedRepo} onChange={e => setRepoId(e.target.value)}>{repositories.map(id => <option key={id} value={id}>{id}</option>)}</select></div>}
          {selectedRepo && <ModelDetail key={selectedRepo} modelId={selectedRepo} installed={selected.local.filter(m => m.sourceRepo === selectedRepo || m.id.includes(selectedRepo.replace('/', '_')))} memory={memory} onBack={() => setSelectedKey(null)} onQueued={onChanged} embedded />}
        </> : <p className="py-8 text-sm text-ink-faint">Select a model to see its details and variants.</p>}
      </div>
    </div>
    )}
    </>
  );
}

function ModelSortSelect({ value, onChange }: { value: ModelSort; onChange: (value: ModelSort) => void }) {
  return (
    <label className="relative shrink-0">
      <span aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint"><ListIcon className="h-4 w-4" /></span>
      <select
        className="quiet-field pl-8 text-xs"
        aria-label="Sort installed models"
        data-model-sort
        value={value}
        onChange={e => onChange(e.target.value as ModelSort)}
      >
        {(Object.keys(MODEL_SORT_LABELS) as ModelSort[]).map(sort => <option key={sort} value={sort}>{MODEL_SORT_LABELS[sort]}</option>)}
      </select>
    </label>
  );
}

/** What a model makes, as quiet tabs. */
function KindFilter({ kind, onChange }: { kind: 'all' | FamilyKind; onChange: (k: 'all' | FamilyKind) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Kind of model">
      {KIND_FILTERS.map(k => <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} data-kind-filter={k.id} className="quiet-tab" onClick={() => onChange(k.id)}>{k.label}</button>)}
    </div>
  );
}
