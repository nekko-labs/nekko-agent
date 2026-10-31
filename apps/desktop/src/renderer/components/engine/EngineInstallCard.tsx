import { useDownloadAction } from './useDownloadAction.js';
import { DownloadProgress } from './DownloadProgress.js';
import { useState } from 'react';
import { ENGINE_BACKEND_LABELS, type EngineInstall } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { DownloadIcon } from '../../icons.js';

/**
 * Getting an engine, before there is one.
 *
 * This is the first screen of the feature for most people, so it answers the
 * three questions that decide whether they press the button: what is being
 * downloaded, why that one, and what happens if they would rather not. The build
 * is named with the hardware it is for, because "CUDA" means nothing to someone
 * who just wants to run a model and "An NVIDIA GPU with a current driver" does.
 *
 * Nothing downloads on its own. That is AN7's standing rule, and it is also the
 * difference between an app that installs software and one that asks first.
 */

export function EngineInstallCard({
  install,
  onChanged,
}: {
  install: EngineInstall;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const download = useDownloadAction({ runtime: 'llama' });
  const busy = download.active;
  const [showOther, setShowOther] = useState(false);
  const [ownPath, setOwnPath] = useState('');
  const [buildId, setBuildId] = useState(install.recommended?.id ?? '');

  const start = async () => {
    const res = await download.run(() => window.nekko.engineInstall(buildId || undefined));
    if (!res) return;
    pushToast(res.ok ? 'info' : 'error', res.message);
    onChanged();
  };

  const useOwn = async () => {
    const path = ownPath.trim();
    if (!path) return;
    await window.nekko.updateSettings({ engineBinPath: path });
    onChanged();
    pushToast('success', 'Using your own llama-server.');
  };

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
      <h3 className="text-sm font-semibold">Run models without installing anything else</h3>
      <p className="mt-1 text-xs text-ink-faint">
        {install.reason ??
          'Nekko Agent can download a small engine and serve models itself, so you do not need LM Studio, Ollama, or vLLM.'}
      </p>

      {install.recommended ? (
        <>
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
            <label className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              Build for this machine
            </label>
            <select
              className="input mt-1 w-full text-xs"
              disabled={busy}
              value={buildId}
              onChange={(e) => setBuildId(e.target.value)}
            >
              {install.available.map((b, i) => (
                <option key={b.id} value={b.id}>
                  {ENGINE_BACKEND_LABELS[b.backend]}
                  {i === 0 ? ' · recommended for this machine' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">
              {install.available.find((b) => b.id === buildId)?.requires ?? install.recommended.requires}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn btn-primary py-1 text-xs" onClick={start} disabled={busy}>
              <DownloadIcon className="mr-1 inline h-3.5 w-3.5" />
              {busy ? 'Downloading…' : 'Download the engine'}
            </button>
            <button className="btn btn-ghost py-1 text-xs" onClick={() => setShowOther((v) => !v)}>
              I already have llama.cpp
            </button>
          </div>
          {busy && <DownloadProgress group={download.group} />}
          <p className="mt-2 text-2xs text-ink-faint">
            From llama.cpp's own GitHub releases: tens of megabytes for Vulkan or CPU, several hundred for CUDA.
            Nothing is downloaded until you press the button.
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs" style={{ color: 'var(--warning, #d1a054)' }}>
          There is no published build for this platform. Point Nekko Agent at a llama-server you built yourself.
        </p>
      )}

      {(showOther || !install.recommended) && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
          <label className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            Path to llama-server
          </label>
          <div className="mt-1 flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              value={ownPath}
              onChange={(e) => setOwnPath(e.target.value)}
              placeholder="/usr/local/bin/llama-server"
              spellCheck={false}
            />
            <button className="btn btn-outline py-1 text-xs" onClick={useOwn} disabled={!ownPath.trim()}>
              Use it
            </button>
          </div>
          <p className="mt-1 text-2xs text-ink-faint">
            A binary you point at is yours: Nekko Agent runs it but never updates or removes it.
          </p>
        </div>
      )}
    </div>
  );
}
