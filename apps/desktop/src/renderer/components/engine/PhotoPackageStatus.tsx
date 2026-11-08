import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadJob, EngineStatus, ImageCompanionStatus } from '@nekko-agent/shared';
import { formatBytes } from '../runtimes/verdict.js';

export function photoReadyLabel(runtime: boolean, companions: ImageCompanionStatus | null): string {
  if (!runtime || !companions?.ready) return 'Finish photo setup';
  const capabilities = companions.capabilities ?? [];
  if (capabilities.includes('video')) return 'Ready to make short clips (experimental)';
  return capabilities.includes('create') && capabilities.includes('edit') ? 'Ready to create and edit photos'
    : capabilities.includes('edit') ? 'Ready to edit photos' : 'Ready to create pictures';
}

/** A local model is a package, not just weights. Readiness includes the engine.
 * Unknown companion sets remain an advanced setup, not a false ready claim. */
export function PhotoPackageStatus({ modelId, onChanged, onDefaults }: {
  modelId: string; onChanged: () => void; onDefaults: (d: ImageCompanionStatus['defaults']) => void;
}) {
  const [setup, setSetup] = useState<{ engine: EngineStatus; files: ImageCompanionStatus | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const lock = useRef(false);
  const live = useRef(false);
  const refresh = useCallback(async () => {
    const [engine, files, downloads] = await Promise.all([window.nekko.engineStatus(), window.nekko.engineImageCompanions(modelId), window.nekko.engineDownloads()]);
    if (live.current) { setSetup({ engine, files }); setJobs(downloads); }
    return { engine, files };
  }, [modelId]);
  useEffect(() => {
    live.current = true;
    void refresh().catch(e => { if (live.current) setError(`Could not check photo setup. ${e.message}`); });
    const off = window.nekko.onDownloadsUpdated(() => { void refresh().catch(() => {}); });
    return () => { live.current = false; off(); };
  }, [refresh]);
  useEffect(() => { if (setup?.files) onDefaults(setup.files.defaults); }, [setup?.files?.setId]);
  const relevant = jobs.filter(j => j.target === modelId && j.id.startsWith('image-companions:') || j.kind === 'engine' && j.id.startsWith('engine:diffusion:'));
  const active = relevant.some(j => ['queued', 'downloading', 'verifying'].includes(j.state));
  const stopped = relevant.find(j => j.state === 'failed' || j.state === 'cancelled');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  const runtime = !!setup?.engine.diffusionInstall?.binPath;
  const ready = runtime && setup?.files?.ready === true;
  const install = async () => {
    if (!setup || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!runtime) {
        const build = setup.engine.diffusionInstall?.recommended;
        if (!build) throw Error('No image engine is available for this computer. Check Models → Runtimes.');
        const result = await window.nekko.engineInstall(build.id, 'diffusion');
        if (!result.ok) throw Error(result.message);
      }
      if (setup.files && !setup.files.ready) {
        const result = await window.nekko.engineDownloadImageCompanions(modelId);
        if (!result.ok) throw Error(result.message);
      }
      await refresh(); onChanged();
    } catch (e) { if (live.current) setError(`${(e as Error).message} Downloaded files are kept; retry to finish setup.`); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return <div className="rounded-lg border border-line p-3 text-xs" data-photo-package>
    <p className="font-medium">{setup ? photoReadyLabel(runtime, setup.files) : 'Checking photo setup…'}</p>
    <p className="mt-1 text-ink-soft">A photo model needs a few parts. Nekko handles them together: the model, supporting files that understand your words and make the picture, and the image engine that runs it.</p>
    <p className="mt-2 text-ink-faint">Generation runs on your Nekko computer. Setup downloads files from Hugging Face and GitHub; it does not send them your prompts or photos.</p>
    {setup && <ul className="mt-3 space-y-1" aria-label="Photo setup checklist">
      <li>✓ Photo model · on this computer</li>
      <li>{runtime ? '✓' : '○'} Image engine · {runtime ? 'installed' : 'download needed'}</li>
      <li>{setup.files?.ready ? '✓' : '○'} Supporting files · {setup.files?.ready ? 'on this computer' : setup.files ? `${formatBytes(setup.files.missingBytes)} to download` : 'custom setup — not automatically verified'}</li>
    </ul>}
    {!ready && setup && (!runtime || setup.files) && <button className="btn btn-outline mt-3 min-h-9 text-xs" disabled={busy || active} onClick={() => void install()}>{busy || active ? 'Setting up…' : 'Finish photo setup'}</button>}
    {active && <p role="status" className="mt-2">Downloading setup files… You can follow progress or cancel in Models → Downloads.</p>}
    {stopped && !active && !ready && !error && <p role="status" className="mt-2">Setup stopped. Downloaded files are kept; retry to finish the missing parts.</p>}
    {!ready && setup?.files && <p className="mt-2 text-ink-faint">Supporting-file size excludes the image engine. Downloads and cancellation are available in Models → Downloads.</p>}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    {!setup && error && <button className="btn btn-outline mt-2" onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Check again</button>}
    {setup?.files && <details className="mt-3 text-ink-faint"><summary className="cursor-pointer">Package details</summary><ul className="mt-2 space-y-1">
      {setup.files.files.map(f => <li className="break-words" key={f.role}>{f.role} · {f.path ? 'On this computer' : formatBytes(f.bytes)}{f.gated ? ' · license approval required' : ''}{f.usingFallback ? ' · compact fallback; detail may be softer' : ''}</li>)}
    </ul></details>}
  </div>;
}
