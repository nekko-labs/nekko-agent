import { useRef, useState } from 'react';
import { DownloadIcon } from '../../icons.js';
import { useDownloadAction } from './useDownloadAction.js';
import { DownloadProgress } from './DownloadProgress.js';

/** Shared acquisition state also locks this build when queued from recommendations. */
export function ModelDownloadButton({ modelId, quant, prepare, onResult }: {
  modelId: string; quant: string; prepare?: () => Promise<boolean>;
  onResult: (res: { ok: boolean; message: string }) => void;
}) {
  const download = useDownloadAction({ model: modelId, quant });
  const [preparing, setPreparing] = useState(false);
  const locked = useRef(false);
  const start = async () => {
    if (locked.current || download.active) return;
    locked.current = true;
    setPreparing(true);
    try {
      if (prepare && !await prepare()) return;
      const res = await download.run(() => window.nekko.engineDownloadModel(modelId, quant));
      if (res) onResult(res);
    } finally { locked.current = false; setPreparing(false); }
  };
  return <div className="shrink-0">
    <button className="rounded-full px-2.5 py-1 text-2xs text-white disabled:opacity-60" style={{ background: 'var(--accent)' }} disabled={preparing || download.active} onClick={() => void start()}>
      <DownloadIcon className="mr-1 inline h-3 w-3" />{preparing || download.active ? 'Downloading…' : 'Download'}
    </button>
    {(preparing || download.active) && <DownloadProgress group={download.group} />}
  </div>;
}
