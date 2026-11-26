import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineBuild, EngineInstallPreview, EngineStatus } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { useVisibleInterval } from '../../visibleInterval.js';
import { ChevronIcon } from '../../icons.js';
import { StatusDot } from '../primitives/index.js';
import { formatBytes } from '../runtimes/verdict.js';
import { EngineUpdateStatus } from './EngineUpdateStatus.js';
import { useDownloadAction } from './useDownloadAction.js';
import { engineGroups, engineInUse, type EngineGroup, type EngineRow, type EngineRuntime } from './engineRows.js';

/** Matches the model server's own poll, so the page moves at one rhythm. */
const POLL_MS = 6000;

/**
 * What runs the models on this computer, one group per kind of model. Every
 * engine is listed: one is in use, the others this machine can run offer Use
 * or Install, and the ones it cannot run stay, with the reason. Folded until
 * asked for; the fold's one line names the engine in use.
 */
export function Engines({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    const next = await window.nekko.engineStatus().catch(() => null);
    if (next) setStatus(next);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useVisibleInterval(() => void refresh(), open ? POLL_MS : null);
  // An engine that finishes installing changes which rows offer what.
  const landed = useRef(0);
  useEffect(() => window.nekko.onDownloadsUpdated((jobs) => {
    const done = jobs.filter((j) => j.kind === 'engine' && j.state === 'done').length;
    if (done !== landed.current) { landed.current = done; void refresh().then(onChanged); }
  }), [refresh, onChanged]);
  const changed = useCallback(() => { void refresh().then(onChanged); }, [refresh, onChanged]);
  const using = engineInUse(status);
  return <details data-models-section="engines" className="group min-w-0 rounded-xl border border-line px-4 py-3"
    onToggle={(e) => { const now = e.currentTarget.open; setOpen(now); if (now) void refresh(); }}>
    <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold [&::-webkit-details-marker]:hidden">
      <ChevronIcon className="h-3.5 w-3.5 text-ink-faint transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />
      Engines
      {using && <span className="ml-auto text-xs font-normal text-ink-faint group-open:hidden" data-engine-in-use>{using.name} in use</span>}
    </summary>
    <EngineGroups groups={engineGroups(status)} builds={status?.diffusionInstall?.available ?? []} loading={!status} open={open} onChanged={changed} />
  </details>;
}

/** The block's body, apart from its fold and its data, so a fixture or a test can render any machine's rows. */
export function EngineGroups({ groups, builds = [], loading = false, open = true, onChanged }: {
  groups: EngineGroup[];
  /** The image engine's builds for this machine, offered while it is not installed. */
  builds?: EngineBuild[];
  loading?: boolean;
  /** Sizes are only looked up while the block is open. */
  open?: boolean;
  onChanged: () => void;
}) {
  return <section className="min-w-0" aria-label="Engines">
    <p className="mt-(--q-tight) text-xs text-ink-faint">What runs your models. Nekko loads a model on the engine in use whenever that engine can run it.</p>
    {loading && <p className="mt-(--q-inline) text-xs text-ink-faint">Checking engines…</p>}
    {groups.map((group) => <div key={group.id} className="mt-(--q-group)" data-engine-group={group.id}>
      <h3 className="quiet-group-label">{group.title}</h3>
      <ul className="-mx-2 mt-(--q-heading)" aria-label={`${group.title} engines`}>
        {group.rows.map((row) => row.runtime
          ? <ManagedRow key={row.id} row={row} runtime={row.runtime} builds={row.id === 'diffusion' ? builds : []} open={open} onChanged={onChanged} />
          : <RowShell key={row.id} row={row} />)}
      </ul>
    </div>)}
  </section>;
}

/** A row's words: the name, what marks it, and one line under it. */
function RowShell({ row, children, trailing }: { row: EngineRow; children?: React.ReactNode; trailing?: React.ReactNode }) {
  // A row that cannot be picked takes no hover wash (`aria-disabled`) and has no actions to reveal.
  return <li className="quiet-row min-h-(--q-row) flex-wrap gap-2 px-2!" data-quiet-row aria-disabled={row.disabled || undefined}
    data-engine={row.id} data-engine-state={row.disabled ? 'disabled' : row.inUse ? 'in-use' : row.installed ? 'installed' : 'available'}>
    {/* Wide enough to read: in a narrow column the version and the action drop to their own line. */}
    <div className="min-w-0 flex-[1_1_16rem]">
      <p className={`text-sm font-medium ${row.disabled ? 'text-ink-faint' : row.inUse ? 'text-accent' : ''}`}>
        {row.name}
        {row.labels.map((label) => <span key={label} className="ml-2 whitespace-nowrap text-xs font-normal text-info-text">{label}</span>)}
        {row.inUse && <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-normal text-ink-soft"><StatusDot tone="success" size={7} />In use</span>}
      </p>
      <p className="mt-(--q-tight) text-xs text-ink-faint">{row.detail}</p>
      {children}
    </div>
    {trailing && <div className="flex min-w-0 flex-wrap items-center gap-2">{trailing}</div>}
  </li>;
}

/** An engine Nekko installs itself: its size before, its progress during, Use or Uninstall after. */
function ManagedRow({ row, runtime, builds, open, onChanged }: { row: EngineRow; runtime: EngineRuntime; builds: EngineBuild[]; open: boolean; onChanged: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const download = useDownloadAction({ runtime });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<EngineInstallPreview | null>(null);
  const [buildId, setBuildId] = useState('');
  const missing = !row.installed && !row.disabled;

  useEffect(() => {
    if (!open || !missing) return;
    let live = true;
    setPreview(null);
    window.nekko.engineInstallPreview(runtime, buildId || undefined)
      .then((p) => { if (live) setPreview(p); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open, missing, runtime, buildId]);

  const act = async (work: () => Promise<{ ok: boolean; message: string } | null>) => {
    if (busy || download.active) return;
    setBusy(true);
    try {
      const res = await work();
      if (res) pushToast(res.ok ? 'info' : 'error', res.message);
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const install = () => act(() => download.run(async () => {
    // The image engine is installed by build id, which only its release names.
    if (runtime !== 'diffusion') return window.nekko.engineInstall(undefined, runtime);
    const found = preview ?? await window.nekko.engineInstallPreview('diffusion', buildId || undefined);
    if (!found) return { ok: false, message: 'No matching release could be read. Check the connection and try again.' };
    return window.nekko.engineInstall(found.build.id, 'diffusion');
  }));
  const uninstall = () => {
    if (!window.confirm(`Remove ${row.name}? Models are kept. Stop the model server first.`)) return;
    void act(() => window.nekko.engineUninstall(runtime));
  };
  const use = () => act(async () => {
    if (row.id !== 'diffusion') await window.nekko.engineSettingsSave({ chatEngine: row.id });
    return null;
  });

  const size = missing && preview ? formatBytes(preview.sizeBytes) : undefined;
  const meta = row.meta ?? size;
  const waiting = busy || download.active;
  return <RowShell row={row} trailing={<>
    {meta && <span className="font-mono text-2xs text-ink-faint" data-engine-meta>{meta}</span>}
    {missing && builds.length > 1 && <select className="quiet-field py-1 text-xs" aria-label={`${row.name} build`} disabled={waiting} value={buildId} onChange={(e) => setBuildId(e.target.value)}>
      <option value="">Recommended build</option>
      {builds.map((b) => <option key={b.id} value={b.id}>{b.backend} · {b.requires}</option>)}
    </select>}
    {row.action === 'use' && <button type="button" className="btn btn-ghost py-1 text-xs" disabled={waiting} onClick={() => void use()}>Use</button>}
    {row.action === 'install' && <button type="button" className={`btn ${row.primary ? 'btn-primary' : 'btn-ghost'} py-1 text-xs`} disabled={waiting} onClick={() => void install()}>
      {download.active ? 'Downloading…' : busy ? 'Starting…' : 'Install'}
    </button>}
    {row.removable && <button type="button" className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" disabled={waiting} onClick={uninstall}>Uninstall</button>}
  </>}>
    {/* llama.cpp's transfer already shows under Model server, below. */}
    {runtime !== 'llama' && <EngineUpdateStatus download={download} onChanged={onChanged} />}
  </RowShell>;
}
