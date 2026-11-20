import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel, EngineMemory, EngineSettings, ImageRecommendedOption, LoadingModel, Recommendations, ResidentModel } from '@nekko-agent/shared';
import { ModelLibrary } from './ModelLibrary.js';
import { ResidentModels } from './ResidentModels.js';
import { ModelDetail } from './ModelDetail.js';
import { RecommendedModels, imageFitText } from './RecommendedModels.js';
import { CheckIcon } from '../../icons.js';
import { familyKind, groupModelFamilies, gpuGuidance, setUpPictureModels, shelveCatalog, type FamilyKind, type LibraryModel, type ModelFamily } from './modelFamilies.js';
import { VoiceSettings } from '../VoiceSettings.js';
import { pictureModelBlurb, pictureTimeText } from './pictureModelText.js';
import { useStore } from '../../store.js';

/**
 * Models, one surface.
 *
 * Installed and downloadable were two tabs once, which made the honest answer
 * to "do I have qwen" depend on which tab you happened to be on. One search box
 * now covers both questions: it filters what is on this machine and searches
 * Hugging Face, so a model you already have and a model you could get sit one
 * after another in the same scroll.
 *
 * Three sections rather than an interleaved list, because the verbs differ:
 * "unload" belongs to what is in memory, "load" to what is on disk, and
 * "download" to what is not — but they share the query, the empty states, and
 * the size/fit vocabulary.
 *
 * Picture and video models are held to a shorter list than chat ones. A chat
 * GGUF is one file that starts; a picture model also needs a text encoder and
 * a VAE, so only the ones Nekko has set up are listed, and what else a search
 * finds from known publishers waits behind "Show more from Hugging Face".
 */
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

export function ModelsHome({
  providerId,
  models,
  canLoad,
  memory,
  resident,
  loading,
  settings,
  running,
  onChanged,
  onOpenModel,
  mlx = false,
}: {
  providerId: string;
  models: LibraryModel[];
  canLoad: boolean;
  memory?: EngineMemory;
  /** The models actually in memory right now, for the "In memory" block. */
  resident: ResidentModel[];
  /** Loads still in flight; the block shows them with progress, not a wait. */
  loading?: LoadingModel[];
  settings: EngineSettings;
  running: boolean;
  onChanged: () => void;
  onOpenModel: (id: string) => void;
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

  useEffect(() => {
    let live = true;
    window.nekko.machineRecommendations().then(r => { if (live) setRecs(r); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setSearching(true);
    setError('');
    const timer = setTimeout(() => {
      window.nekko.engineCatalog(query.trim() || undefined, format).then((next) => {
        if (live) setCatalog(next);
      }).catch(() => {
        if (live) { setCatalog([]); setError('Catalog unavailable. Your downloaded models are still here.'); }
      }).finally(() => { if (live) setSearching(false); });
    }, query ? 350 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [query, format]);

  // A jump to one model's settings from elsewhere: when it is not in memory its
  // drawer lives in its family's variant list, so that family is selected and
  // any search or kind filter that would hide it is cleared. ModelLibrary then
  // opens the row and clears the request.
  const focus = useStore((s) => s.localModelFocus);
  const focusLoaded = !!focus && resident.some((r) => r.id === focus);
  const picks = useMemo(() => setUpPictureModels(recs), [recs]);
  // The starter list stays chat only: the picks join it under Pictures or Video, or once there is a search.
  const shelves = useMemo(() => shelveCatalog(catalog, picks, models, kind !== 'all' || !!query.trim()), [catalog, picks, models, kind, query]);
  const families = useMemo(() => groupModelFamilies(models, [...shelves.listed, ...shelves.more]), [models, shelves]);
  const matching = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return families.filter(f => (kind === 'all' || familyKind(f) === kind) && words.every(word => [f.name, ...f.local.flatMap(m => [m.name, m.sourceRepo, m.quantization, m.folderProvider]), ...f.catalog.flatMap(m => [m.name, m.id, ...m.tags])].join(' ').toLowerCase().includes(word)));
  }, [families, query, kind]);
  useEffect(() => {
    if (!focus || focusLoaded) return;
    const family = families.find(f => f.local.some(m => m.id === focus));
    if (!family) return;
    setQuery('');
    setKind('all');
    setSelectedKey(family.key);
    setRepoId(null);
  }, [focus, focusLoaded, families]);
  const moreIds = useMemo(() => new Set(shelves.more.map(m => m.id)), [shelves]);
  const extra = useMemo(() => matching.filter(f => isMoreFamily(f, moreIds)), [matching, moreIds]);
  const main = useMemo(() => matching.filter(f => !extra.includes(f)), [matching, extra]);
  const visible = showMore ? [...main, ...extra] : main;
  const note = kindNote(kind, query, visible.length + extra.length);
  const selected = visible.find(f => f.key === selectedKey) ?? visible[0];
  const repositories = [...new Set([...(selected?.catalog.map(m => m.id) ?? []), ...(selected?.local.map(m => m.sourceRepo).filter((id): id is string => Boolean(id)) ?? [])])];
  const selectedRepo = repositories.includes(repoId ?? '') ? repoId! : repositories[0];

  const row = (f: ModelFamily) => {
    const smallest = f.local.slice().sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
    const sizes = f.catalog.flatMap(m => m.quants.map(q => q.sizeBytes ?? 0)).filter(Boolean);
    const setUp = setUpModelOf(f, picks);
    const pick = smallest ? undefined : setUp;
    const fit = pick ? setUpFitText(pick) : gpuGuidance(smallest?.sizeBytes ?? (sizes.length ? Math.min(...sizes) : undefined), memory, smallest);
    const time = setUp ? pictureTimeText(setUp) : null;
    const title = time ? time.title : pick ? 'From the recommendations for this machine, with its supporting files counted' : smallest ? 'Planner result for the smallest downloaded variant' : 'Estimate from file size, not a measured context limit';
    return <button key={f.key} className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-2" style={{ background: selected?.key === f.key ? 'var(--accent-soft)' : undefined }} aria-pressed={selected?.key === f.key} onClick={() => { setSelectedKey(f.key); setRepoId(null); }}>
      <div className="min-w-0 flex-1"><p className="break-words text-xs font-medium">{setUp?.name ?? f.name}</p><p className="mt-0.5 text-2xs text-ink-faint" data-model-line>{setUp ? pictureModelBlurb(setUp) : `${f.local.length ? `${f.local.length} downloaded · ` : ''}${f.catalog.length} source${f.catalog.length === 1 ? '' : 's'}`}</p><p className="mt-1 text-2xs text-ink-soft" title={title}>{fit}{!pick && !smallest && memory?.kind !== 'ram' && fit !== 'GPU fit unknown' ? ' (estimated)' : ''}{time ? ` · ${time.text}` : ''}</p></div>
      {f.local.length > 0 && <span className="shrink-0 text-success" aria-label="Downloaded"><CheckIcon className="h-4 w-4" /></span>}
    </button>;
  };

  return (
    <>
    <RecommendedModels models={models} onQueued={onChanged} />
    <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
      <div className="min-w-0 lg:border-r lg:border-line lg:pr-5">
        <input className="input w-full text-xs" aria-label="Search models" placeholder="Search models and Hugging Face" value={query} onChange={e => setQuery(e.target.value)} spellCheck={false} />
        <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Kind of model">
          {KIND_FILTERS.map(k => <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} data-kind-filter={k.id} className="rounded-full border px-2.5 py-0.5 text-2xs" style={kind === k.id ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--ink)' } : { borderColor: 'var(--line)', color: 'var(--ink-soft)' }} onClick={() => { setKind(k.id); setSelectedKey(null); }}>{k.label}</button>)}
        </div>
        {note && <p role="status" className="mt-2 text-2xs text-ink-soft" data-kind-note>{note}</p>}
        {mlx && <select className="input mt-2 text-xs" aria-label="Catalog format" value={format} onChange={e => setFormat(e.target.value as 'gguf' | 'mlx')}><option value="gguf">GGUF</option><option value="mlx">MLX</option></select>}
        <p className="mt-2 text-2xs text-ink-faint">{searching ? 'Searching…' : `${visible.length} models`} · Checkmarks mean downloaded</p>
        {error && <p role="status" className="mt-2 text-xs text-ink-faint">{error}</p>}
        <div className="mt-3 max-h-[65vh] space-y-1 overflow-y-auto" aria-label="Models">
          {main.map(row)}
          {extra.length > 0 && <button type="button" className="btn btn-ghost mt-2 text-xs" aria-expanded={showMore} data-more-models onClick={() => setShowMore(v => !v)}>{showMore ? 'Hide' : 'Show'} {extra.length} more from Hugging Face</button>}
          {showMore && extra.length > 0 && <p className="px-3 py-1 text-2xs text-ink-faint" data-more-note>Not set up by Nekko. These may need extra files, or not start.</p>}
          {showMore && extra.map(row)}
          {!searching && !visible.length && !extra.length && !note && <p className="py-4 text-xs text-ink-faint">No matching models. Try a shorter search.</p>}
        </div>
      </div>
      <div className="min-w-0" aria-label="Model details">
        {/* What is in memory (or on its way) leads the page: "what is running"
            is the question a load click is really asking. */}
        <div className="mb-4">
          <ResidentModels providerId={providerId} resident={resident} loading={loading} models={models} settings={settings} onChanged={onChanged} />
        </div>
        {/* Speech recognizers are models too, but the OS or Nekko Voice runs
            them, not the engine: they get their own block with install, remove
            and "use for dictation" instead of a Load button. */}
        <details className="mb-4 rounded-xl border border-line px-3 py-2" aria-label="System models">
          <summary className="cursor-pointer text-sm font-semibold">System models</summary>
          <div className="mt-2"><VoiceSettings compact /></div>
        </details>
        {selected ? <>
          <h3 className="break-words text-xl font-semibold">{setUpModelOf(selected, picks)?.name ?? selected.name}</h3>
          <p className="mt-1 text-xs text-ink-faint">Choose a variant to download, load or configure. B means billions of parameters.</p>
          <h4 className="mt-5 text-sm font-semibold">Variants on this machine</h4>
          <div className="mt-2"><ModelLibrary providerId={providerId} models={selected.local} resident={resident} canLoad={canLoad} onChanged={onChanged} autoloadIds={new Set(settings.autoload ?? [])} running={running} /></div>
          {repositories.length > 0 && <div className="mt-5"><label className="block text-xs text-ink-faint" htmlFor="model-source">Variant provider / repository</label><select id="model-source" className="input mt-1 w-full text-xs" value={selectedRepo} onChange={e => setRepoId(e.target.value)}>{repositories.map(id => <option key={id} value={id}>{id}</option>)}</select></div>}
          {selectedRepo && <ModelDetail key={selectedRepo} modelId={selectedRepo} installed={selected.local.filter(m => m.sourceRepo === selectedRepo || m.id.includes(selectedRepo.replace('/', '_')))} memory={memory} onBack={() => setSelectedKey(null)} onQueued={onChanged} embedded />}
        </> : <><p className="py-8 text-sm text-ink-faint">Select a model to see its details and variants.</p><ModelLibrary providerId={providerId} models={[]} canLoad={canLoad} onChanged={onChanged} /></>}
      </div>
    </div>
    </>
  );
}
