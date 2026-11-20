import { useEffect, useRef, useState } from 'react';
import type { EngineMemory, EngineSettings, LoadingModel, LocalModel, ResidentModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';
import { ImageGeneration } from './ImageGeneration.js';
import { StatusDot } from '../primitives/index.js';

/**
 * The models actually in memory right now.
 *
 * "Loaded" used to be a badge on a row halfway down the library, which answered
 * the wrong question. What is resident is its own concern: how much of the
 * machine it holds, how long until each is evicted, and the two verbs that
 * change that (unload, keep). It sits above the library because it is the
 * answer to "what is running" rather than "what do I have".
 *
 * Since the Models page rework it leads the local section as plain rows under
 * "Running now", above the library, with one meter for how much of the
 * machine's model memory they hold together.
 */

/** Countdown text is live for a minute-scale value; five seconds is enough. */
const TICK_MS = 5000;

export function ResidentModels({
  providerId,
  resident,
  loading = [],
  models,
  settings,
  memory,
  onChanged,
}: {
  providerId: string;
  /** The model memory budget, for the meter; none on a machine the engine cannot measure. */
  memory?: EngineMemory;
  resident: ResidentModel[];
  /** Loads still streaming in: they belong here before they count as resident. */
  loading?: LoadingModel[];
  models: Array<LocalModel & { loaded: boolean }>;
  settings: EngineSettings;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Set when the drawer was opened by a jump from another surface.
  const [jumped, setJumped] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const focus = useStore((s) => s.localModelFocus);
  const clearFocus = useStore((s) => s.clearLocalModelFocus);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // Another surface (the Local models panel, the chat's model dock) asked for
  // one model's settings: unfold its drawer and bring the row into view. The
  // request waits until that model is in the resident list, since the first
  // status read can land after this page mounts, and is dropped once served.
  useEffect(() => {
    if (!focus || !resident.some((r) => r.id === focus) || !models.some((m) => m.id === focus)) return;
    setOpen(focus);
    setJumped(focus);
    clearFocus();
    requestAnimationFrame(() => rowRefs.current.get(focus)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [focus, resident, models, clearFocus]);

  const loadingRows = loading.filter((l) => !resident.some((r) => r.id === l.id));

  // A load's elapsed time and percentage want a livelier tick than idle text.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), loadingRows.length ? 1000 : TICK_MS);
    return () => clearInterval(t);
  }, [loadingRows.length]);

  const byId = new Map(models.map((m) => [m.id, m]));
  const totalBytes = resident.reduce((n, r) => n + (r.vramBytes ?? r.sizeBytes ?? 0), 0);

  const unload = async (id: string) => {
    setBusy(id);
    const res = await window.nekko
      .unloadModel(providerId, id)
      .catch(() => ({ ok: false, message: "Couldn't unload it." }));
    setBusy(null);
    pushToast(res.ok ? 'info' : 'error', res.message ?? 'Unloaded.');
    onChanged();
  };

  const setTtl = async (id: string, ttlSeconds: number) => {
    setBusy(id);
    const res = await window.nekko
      .engineSetResidentTtl(id, ttlSeconds)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message);
    onChanged();
  };

  return (
    <div className="min-w-0" data-running-models>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="quiet-group-label">Running now</h3>
        <p className="text-xs text-ink-faint">
          {[
            resident.length === 0
              ? 'nothing loaded'
              : `${resident.length} of ${Math.max(1, settings.maxLoaded)} slot${Math.max(1, settings.maxLoaded) === 1 ? '' : 's'}` +
                (totalBytes > 0 ? ` · ${formatBytes(totalBytes)}${memory?.budgetBytes ? ` of ${formatBytes(memory.budgetBytes)}` : ''}` : ''),
            loadingRows.length ? `${loadingRows.length} loading` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {totalBytes > 0 && memory?.budgetBytes ? (
        <span className="mt-(--q-heading) block h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label="Model memory in use" aria-valuemin={0} aria-valuemax={memory.budgetBytes} aria-valuenow={totalBytes}>
          <span className="block h-full rounded-full bg-accent transition-[width] duration-(--dur-slow) ease-(--ease-out)" style={{ width: `${Math.min(100, (totalBytes / memory.budgetBytes) * 100)}%` }} />
        </span>
      ) : null}
      {resident.length === 0 && loadingRows.length === 0 ? (
        <p className="mt-(--q-inline) text-xs text-ink-faint">
          Load a model below, or let one load itself when a request arrives
          {settings.jitLoad ? '' : ' (load-on-demand is off)'}.
        </p>
      ) : (
        <div className="mt-(--q-tight)">
          {loadingRows.map((l) => (
            <LoadingRow key={l.id} load={l} name={byId.get(l.id)?.name ?? l.id} elapsedMs={now - l.startedAt} />
          ))}
          {resident.map((r) => {
            const model = byId.get(r.id);
            const idleFor = r.lastUsedAt ? now - r.lastUsedAt : 0;
            const evictIn = r.expiresAt ? r.expiresAt - now : undefined;
            const kept = !r.expiresAt;
            return (
              <div
                key={r.id}
                data-resident-row={r.id}
                className="scroll-mt-4"
                ref={(el) => {
                  if (el) rowRefs.current.set(r.id, el);
                  else rowRefs.current.delete(r.id);
                }}
              >
              <div className="-mx-2 flex min-h-(--q-row) flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-(--q-inline) transition-colors duration-(--dur-fast) hover:bg-(--q-wash)" data-quiet-row>
                <StatusDot tone="success" />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{model?.name ?? r.id}</span>
                    {model?.quantization && <span className="shrink-0 text-xs text-ink-faint">{model.quantization}</span>}
                  </p>
                  <p className="mt-(--q-tight) text-xs text-ink-faint">
                    {[
                      formatBytes(r.vramBytes ?? r.sizeBytes ?? 0),
                      r.contextLength ? `${formatTokens(r.contextLength)}${model?.maxContext ? ` of ${formatTokens(model.maxContext)}` : ''} context` : undefined,
                      model?.modality && model.modality !== 'chat' ? model.modality : undefined,
                      idleFor > 20_000 ? `idle ${formatAge(idleFor)}` : 'in use',
                      evictIn !== undefined ? `unloads in ${formatAge(Math.max(0, evictIn))}` : 'stays loaded',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Where the weights live is the first thing to know about a
                      running model: all-GPU is fast, partly CPU much less so. */}
                  {r.loadedOn && (
                    <span
                      className={`text-xs ${r.loadedOn !== 'gpu' ? 'text-warning-text' : 'text-ink-faint'}`}
                      title={placementTitle(r)}
                    >
                      {placementLabel(r)}
                    </span>
                  )}
                  {model && (
                    <button
                      className={`btn btn-ghost py-1 text-xs ${open === r.id ? 'text-accent' : ''}`}
                      aria-expanded={open === r.id}
                      title="Adjust this model's settings and reload it"
                      onClick={() => { setJumped(null); setOpen(open === r.id ? null : r.id); }}
                    >
                      Settings
                    </button>
                  )}
                  <button
                    className="btn btn-ghost py-1 text-xs"
                    disabled={busy === r.id}
                    title={
                      kept
                        ? `Unload after ${settings.idleTtlSeconds}s idle instead of staying resident`
                        : 'Keep this model loaded until you unload it'
                    }
                    onClick={() => void setTtl(r.id, kept ? settings.idleTtlSeconds : 0)}
                  >
                    {kept ? 'Use idle limit' : 'Keep loaded'}
                  </button>
                  <button
                    className="btn btn-ghost py-1 text-xs"
                    disabled={busy === r.id}
                    onClick={() => void unload(r.id)}
                  >
                    {busy === r.id ? 'Unloading…' : 'Unload'}
                  </button>
                </div>
              </div>
              {/* The model's own settings, one click from the row that says it
                  is loaded. The drawer folds shut the same way it opens, and
                  its primary verb reloads with whatever was changed. */}
              {/* A picture model's settings are its companion files and defaults,
                  not a context window or GPU layers. */}
              {open === r.id && model?.modality === 'image' && <ImageGeneration model={model} onChanged={onChanged} />}
              {open === r.id && model && model.modality !== 'image' && (
                <EngineLoadDrawer
                  providerId={providerId}
                  model={{ ...model, loaded: true }}
                  loadedParams={r.params}
                  onDone={() => { onChanged(); }}
                  onClose={() => setOpen(null)}
                  initialSurface={jumped === r.id ? 'advanced' : 'simple'}
                />
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "4 min", "1 hr 12 min", "2 days" — ages, not timestamps. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * One load still on its way into memory. The bar fills when the engine can
 * measure it — free VRAM sinking as tensors land — and runs as a plain moving
 * mark when it cannot (a CPU load, or a machine with no GPU probe), which is
 * more honest than a number that cannot be known.
 */
function LoadingRow({ load, name, elapsedMs }: { load: LoadingModel; name: string; elapsedMs: number }) {
  const pct = load.progress === undefined ? null : Math.round(load.progress * 100);
  return (
    <div className="-mx-2 rounded-lg px-2 py-(--q-inline) text-xs" data-quiet-row data-loading-row>
      <div className="flex items-center gap-3">
        <StatusDot color="var(--accent)" pulse />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint">
          {load.phase === 'queued' ? 'queued' : pct === null ? 'loading' : `${pct}%`}
        </span>
      </div>
      {load.phase === 'loading' && (
        <div
          className="mt-(--q-tight) ml-5 h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={pct ?? undefined}
          aria-label={`Loading ${name}`}
        >
          <div
            className="h-full w-full origin-left rounded-full transition-transform duration-200 ease-(--ease-out)"
            style={{
              transform: `scaleX(${pct === null ? 0.35 : Math.max(4, Math.min(100, pct)) / 100})`,
              background: 'var(--accent)',
              opacity: pct === null ? 0.5 : 1,
            }}
          />
        </div>
      )}
      <p className="mt-(--q-tight) ml-5 text-xs text-ink-faint">
        {load.phase === 'queued'
          ? 'Loads run one at a time; this starts when the one ahead of it finishes.'
          : `Reading the file into memory · ${formatAge(elapsedMs)} so far`}
      </p>
    </div>
  );
}
