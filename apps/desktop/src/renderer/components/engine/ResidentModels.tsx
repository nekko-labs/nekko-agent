import { useEffect, useRef, useState } from 'react';
import type { EngineSettings, LoadingModel, LocalModel, ResidentModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from '../runtimes/verdict.js';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';

/**
 * The models actually in memory right now.
 *
 * "Loaded" used to be a badge on a row halfway down the library, which answered
 * the wrong question. What is resident is its own concern: how much of the
 * machine it holds, how long until each is evicted, and the two verbs that
 * change that (unload, keep). It sits above the library because it is the
 * answer to "what is running" rather than "what do I have".
 */

/** Countdown text is live for a minute-scale value; five seconds is enough. */
const TICK_MS = 5000;

export function ResidentModels({
  providerId,
  resident,
  loading = [],
  models,
  settings,
  onChanged,
}: {
  providerId: string;
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
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold">In memory</p>
        <p className="text-2xs text-ink-faint">
          {[
            resident.length === 0
              ? 'nothing loaded'
              : `${resident.length} of ${Math.max(1, settings.maxLoaded)} slot${Math.max(1, settings.maxLoaded) === 1 ? '' : 's'}` +
                (totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''),
            loadingRows.length ? `${loadingRows.length} loading` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {resident.length === 0 && loadingRows.length === 0 ? (
        <p className="mt-1.5 text-xs text-ink-faint">
          Load a model below, or let one load itself when a request arrives
          {settings.jitLoad ? '' : ' (load-on-demand is off)'}.
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
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
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--line)' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} />
                    <span className="truncate font-medium">{model?.name ?? r.id}</span>
                    {model?.modality && model.modality !== 'chat' && (
                      <span className="chip shrink-0 text-2xs">{model.modality === 'vision' ? 'vision' : model.modality}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {[
                      formatBytes(r.vramBytes ?? r.sizeBytes ?? 0),
                      r.contextLength ? `${formatTokens(r.contextLength)} context` : undefined,
                      idleFor > 20_000 ? `idle ${formatAge(idleFor)}` : 'in use',
                      evictIn !== undefined ? `unloads in ${formatAge(Math.max(0, evictIn))}` : 'stays loaded',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Where the weights live is the first thing to know about a
                      running model: all-GPU is fast, partly CPU much less so. */}
                  {r.loadedOn && (
                    <span
                      className="text-2xs text-ink-faint"
                      style={r.loadedOn !== 'gpu' ? { color: 'var(--warning, #d1a054)' } : undefined}
                      title={placementTitle(r)}
                    >
                      {placementLabel(r)}
                    </span>
                  )}
                  {model && (
                    <button
                      className="rounded-full border px-2 py-1 text-2xs hover:border-[var(--accent)]"
                      style={{ borderColor: open === r.id ? 'var(--accent)' : 'var(--line)' }}
                      title="Adjust this model's settings and reload it"
                      onClick={() => { setJumped(null); setOpen(open === r.id ? null : r.id); }}
                    >
                      Settings
                    </button>
                  )}
                  <button
                    className="rounded-full border px-2 py-1 text-2xs"
                    style={{ borderColor: 'var(--line)' }}
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
                    className="rounded-full border px-2 py-1 text-2xs"
                    style={{ borderColor: 'var(--line)' }}
                    disabled={busy === r.id}
                    onClick={() => void unload(r.id)}
                  >
                    {busy === r.id ? 'unloading…' : 'Unload'}
                  </button>
                </div>
              </div>
              {/* The model's own settings, one click from the row that says it
                  is loaded. The drawer folds shut the same way it opens, and
                  its primary verb reloads with whatever was changed. */}
              {open === r.id && model && (
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
    <div className="rounded-lg border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint">
          {load.phase === 'queued' ? 'queued' : pct === null ? 'loading' : `${pct}%`}
        </span>
      </div>
      {load.phase === 'loading' && (
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: 'color-mix(in srgb, var(--ink-faint) 15%, transparent)' }}
          role="progressbar"
          aria-valuenow={pct ?? undefined}
          aria-label={`Loading ${name}`}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: pct === null ? '35%' : `${Math.max(4, pct)}%`,
              background: 'var(--accent)',
              opacity: pct === null ? 0.5 : 1,
            }}
          />
        </div>
      )}
      <p className="mt-1 text-2xs text-ink-faint">
        {load.phase === 'queued'
          ? 'Loads run one at a time; this starts when the one ahead of it finishes.'
          : `Reading the file into memory · ${formatAge(elapsedMs)} so far`}
      </p>
    </div>
  );
}
