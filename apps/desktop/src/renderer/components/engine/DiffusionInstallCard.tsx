import { useDownloadAction } from './useDownloadAction.js';
import { DownloadProgress } from './DownloadProgress.js';
import { useEffect, useState } from 'react';
import type { EngineInstall, EngineInstallPreview } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes } from '../runtimes/verdict.js';

export function DiffusionInstallCard({ install, onChanged }: { install?: EngineInstall; onChanged: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const [preview, setPreview] = useState<EngineInstallPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const download = useDownloadAction({ runtime: 'diffusion' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [buildId, setBuildId] = useState('');
  const check = async () => {
    setChecking(true); setError('');
    try {
      const p = await window.nekko.engineInstallPreview('diffusion', buildId || undefined);
      setPreview(p);
      if (!p) setError('No matching release could be read. Check the connection or choose another build.');
    } catch (e) { setError((e as Error).message); }
    finally { setChecking(false); }
  };
  const act = async (remove: boolean) => {
    if (busy || download.active) return;
    if (remove && !window.confirm('Remove the managed image generation runtime? Models are kept. Stop the model server first.')) return;
    if (!remove && !preview) return;
    setBusy(true);
    try {
      const res = remove ? await window.nekko.engineUninstall('diffusion') : await download.run(() => window.nekko.engineInstall(preview!.build.id, 'diffusion'));
      if (!res) return;
      pushToast(res.ok ? 'info' : 'error', res.message);
      onChanged();
    } catch (e) { pushToast('error', (e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { setPreview(null); if (!install?.binPath) void check(); }, [buildId, install?.binPath]);
  return <div className="mt-5 border-t border-line pt-4">
    <h3 className="text-sm font-semibold">Image Generation Runtime</h3>
    <p className="mt-1 text-xs text-ink-faint">stable-diffusion.cpp runs image models such as SD3.5 and FLUX. It is optional and downloaded only when you choose Install.</p>
    {install?.binPath ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span>{install.version ?? 'Installed'} · {install.source === 'external' ? 'External binary, never removed here' : 'Managed'}</span>
      {install.source === 'managed' && <button className="btn btn-outline ml-auto py-1 text-xs" disabled={busy || download.active} onClick={() => void act(true)}>Uninstall image generation runtime</button>}
    </div> : <>
      <select className="input mt-2 w-full text-xs" disabled={busy || download.active} aria-label="Image generation runtime build" value={buildId} onChange={e => setBuildId(e.target.value)}>
        <option value="">Recommended for this machine</option>
        {install?.available.map(b => <option key={b.id} value={b.id}>{b.backend} · {b.requires}</option>)}
      </select>
      {preview && <p className="mt-2 text-xs">{preview.version} · {preview.build.backend} · {formatBytes(preview.sizeBytes)} download{preview.files.length > 1 ? ' (including runtime libraries)' : ''}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn btn-outline py-1 text-xs" disabled={checking || busy || download.active} onClick={() => void check()}>{checking ? 'Checking…' : 'Check version and size'}</button>
        {preview && <button className="btn btn-primary py-1 text-xs" disabled={busy || download.active} onClick={() => void act(false)}>{download.active ? 'Downloading…' : busy ? 'Starting…' : 'Install image generation runtime'}</button>}
      </div>
      {download.active && <DownloadProgress group={download.group} />}
      {error && <p role="alert" className="mt-2 text-xs text-ink-soft">{error}</p>}
    </>}
  </div>;
}
