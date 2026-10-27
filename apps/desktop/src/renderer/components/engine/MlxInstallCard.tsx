import { useDownloadAction } from './useDownloadAction.js';
import { DownloadProgress } from './DownloadProgress.js';
import { useEffect, useState } from 'react';
import type { EngineInstall, EngineInstallPreview } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * MLX, on an Apple Silicon Mac: Apple's own framework, usually the fastest
 * way to run a model there. Optional, and nothing is downloaded until Install.
 * Renders nothing on any other machine.
 */
export function MlxInstallCard({ install, onChanged }: { install?: EngineInstall; onChanged: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [preview, setPreview] = useState<EngineInstallPreview | null>(null);
  const download = useDownloadAction({ runtime: 'mlx' });
  const [busy, setBusy] = useState(false);
  const supported = Boolean(install?.available.length);

  useEffect(() => {
    if (!supported || install?.binPath) return;
    void window.nekko.engineInstallPreview('mlx').then(setPreview).catch(() => setPreview(null));
  }, [supported, install?.binPath]);

  if (!supported) return null;

  const act = async (remove: boolean) => {
    if (busy || download.active) return;
    if (remove && !window.confirm('Remove MLX? Models are kept. Stop the model server first.')) return;
    setBusy(true);
    try {
      const res = remove ? await window.nekko.engineUninstall('mlx') : await download.run(() => window.nekko.engineInstall(undefined, 'mlx'));
      if (!res) return;
      pushToast(res.ok ? 'info' : 'error', res.message);
      onChanged();
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold">MLX runtime</h3>
      <p className="mt-1 text-[12px] text-ink-faint">
        Apple&apos;s framework for Apple Silicon, often the fastest way to run a model on this Mac. It runs MLX models,
        including the ones LM Studio downloads. Optional, and installed only when you choose Install.
      </p>
      {install?.binPath ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span>{install.version ?? 'Installed'} · {install.source === 'external' ? 'Your own install, never removed here' : 'Managed'}</span>
          {install.source === 'managed' && (
            <button className="btn btn-outline ml-auto py-1 text-[12px]" disabled={busy || download.active} onClick={() => void act(true)}>
              Uninstall MLX
            </button>
          )}
        </div>
      ) : (
        <>
          {preview && (
            <p className="mt-2 text-[12px]">
              {preview.version} · about {formatBytes(preview.sizeBytes)}, including its own Python (your system Python is not touched)
            </p>
          )}
          <button className="btn btn-primary mt-2 py-1 text-[12px]" disabled={busy || download.active} onClick={() => void act(false)}>
            {download.active ? 'Downloading…' : busy ? 'Starting…' : 'Install MLX'}
          </button>
          {download.active && <DownloadProgress group={download.group} />}
          {install?.reason && install.reason !== 'MLX is not installed yet.' && (
            <p role="alert" className="mt-2 text-[12px] text-ink-soft">{install.reason}</p>
          )}
        </>
      )}
    </div>
  );
}
