import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel, EngineMemory, EngineSettings, LoadingModel, ResidentModel } from '@nekko-agent/shared';
import { ModelLibrary } from './ModelLibrary.js';
import { ResidentModels } from './ResidentModels.js';
import { ModelDetail } from './ModelDetail.js';
import { RecommendedModels } from './RecommendedModels.js';
import { CheckIcon } from '../../icons.js';
import { groupModelFamilies, gpuGuidance, type LibraryModel } from './modelFamilies.js';
import { VoiceSettings } from '../VoiceSettings.js';

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
 */
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

  const families = useMemo(() => groupModelFamilies(models, catalog), [models, catalog]);
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return families.filter(f => words.every(word => [f.name, ...f.local.flatMap(m => [m.name, m.sourceRepo, m.quantization, m.folderProvider]), ...f.catalog.flatMap(m => [m.name, m.id, ...m.tags])].join(' ').toLowerCase().includes(word)));
  }, [families, query]);
  const selected = visible.find(f => f.key === selectedKey) ?? visible[0];
  const repositories = [...new Set([...(selected?.catalog.map(m => m.id) ?? []), ...(selected?.local.map(m => m.sourceRepo).filter((id): id is string => Boolean(id)) ?? [])])];
  const selectedRepo = repositories.includes(repoId ?? '') ? repoId! : repositories[0];

  return (
    <>
    <RecommendedModels models={models} onQueued={onChanged} />
    <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
      <div className="min-w-0 lg:border-r lg:border-line lg:pr-5">
        <input className="input w-full text-xs" aria-label="Search models" placeholder="Search models and Hugging Face" value={query} onChange={e => setQuery(e.target.value)} spellCheck={false} />
        {mlx && <select className="input mt-2 text-xs" aria-label="Catalog format" value={format} onChange={e => setFormat(e.target.value as 'gguf' | 'mlx')}><option value="gguf">GGUF</option><option value="mlx">MLX</option></select>}
        <p className="mt-2 text-2xs text-ink-faint">{searching ? 'Searching…' : `${visible.length} models`} · Checkmarks mean downloaded</p>
        {error && <p role="status" className="mt-2 text-xs text-ink-faint">{error}</p>}
        <div className="mt-3 max-h-[65vh] space-y-1 overflow-y-auto" aria-label="Models">
          {visible.map(f => {
            const smallest = f.local.slice().sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
            const sizes = f.catalog.flatMap(m => m.quants.map(q => q.sizeBytes ?? 0)).filter(Boolean);
            const fit = gpuGuidance(smallest?.sizeBytes ?? (sizes.length ? Math.min(...sizes) : undefined), memory, smallest);
            return <button key={f.key} className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-2" style={{ background: selected?.key === f.key ? 'var(--accent-soft)' : undefined }} aria-pressed={selected?.key === f.key} onClick={() => { setSelectedKey(f.key); setRepoId(null); }}>
              <div className="min-w-0 flex-1"><p className="break-words text-xs font-medium">{f.name}</p><p className="mt-0.5 text-2xs text-ink-faint">{f.local.length ? `${f.local.length} downloaded · ` : ''}{f.catalog.length} source{f.catalog.length === 1 ? '' : 's'}</p><p className="mt-1 text-2xs text-ink-soft" title={smallest ? 'Planner result for the smallest downloaded variant' : 'Estimate from file size, not a measured context limit'}>{fit}{!smallest && memory?.kind !== 'ram' && fit !== 'GPU fit unknown' ? ' (estimated)' : ''}</p></div>
              {f.local.length > 0 && <span className="shrink-0 text-success" aria-label="Downloaded"><CheckIcon className="h-4 w-4" /></span>}
            </button>;
          })}
          {!searching && !visible.length && <p className="py-4 text-xs text-ink-faint">No matching models. Try a shorter search.</p>}
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
          <h3 className="break-words text-xl font-semibold">{selected.name}</h3>
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
