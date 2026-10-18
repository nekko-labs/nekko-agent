import { useEffect, useState } from 'react';
import type { LocalModel, ImageCompanionStatus } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes } from '../runtimes/verdict.js';

const ROLE_LABEL: Record<ImageCompanionStatus['files'][number]['role'], string> = {
  clip_l: 'CLIP-L text encoder', clip_g: 'CLIP-G text encoder', t5xxl: 'T5-XXL text encoder', llm: 'LLM text encoder', vae: 'VAE', taesd: 'TAESD decoder',
};

/**
 * The text encoders and VAE a diffusion model needs, with one press to fetch
 * whichever are missing. Polls while a fetch is running so the rows tick over
 * as files land.
 */
function ImageCompanions({ model, onChanged, onDefaults }: { model: LocalModel; onChanged: () => void; onDefaults: (d: ImageCompanionStatus['defaults']) => void }) {
  const pushToast = useStore(s => s.pushToast);
  const [status, setStatus] = useState<ImageCompanionStatus | null | undefined>(undefined);
  const [fetching, setFetching] = useState(false);
  const refresh = () => window.nekko.engineImageCompanions(model.id).then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void refresh(); }, [model.id]);
  useEffect(() => { if (status) onDefaults(status.defaults); }, [status?.setId]);
  useEffect(() => {
    if (!fetching) return;
    const t = setInterval(() => void window.nekko.engineImageCompanions(model.id).then(s => {
      setStatus(s);
      if (s?.ready) { setFetching(false); onChanged(); }
      else void window.nekko.engineDownloads().then(jobs => {
        const relevant = jobs.filter(job => job.target === model.id && job.id.startsWith('image-companions:'));
        if (relevant.length && !relevant.some(job => ['queued', 'downloading', 'verifying'].includes(job.state))) {
          setFetching(false);
          pushToast('error', 'Image setup did not finish. Check Downloads for details, then retry.');
        }
      }).catch(() => setFetching(false));
    }).catch(() => setFetching(false)), 3000);
    return () => clearInterval(t);
  }, [fetching, model.id]);
  if (!status) return null;
  const download = async () => {
    const res = await window.nekko.engineDownloadImageCompanions(model.id).catch((e: Error) => ({ ok: false, message: e.message }));
    pushToast(res.ok ? 'info' : 'error', res.message);
    if (res.ok) setFetching(true);
  };
  return <div className="rounded-lg border border-line p-3 text-[12px]">
    <p className="font-medium">{status.ready ? 'Ready to create images' : 'Finish image setup'}</p>
    <p className="mt-1 text-ink-soft">{status.label} needs supporting files to understand your prompt and turn it into a picture. Download them once, then generate locally. Downloads use your internet connection; your prompt is not sent.</p>
    <ul className="mt-1 space-y-0.5">
      {status.files.map(f => <li key={f.role} className="flex gap-2">
        <span aria-hidden>{f.path ? '✓' : '·'}</span>
        <span>{f.usingFallback ? ROLE_LABEL.taesd : ROLE_LABEL[f.role]}</span>
        <span className="ml-auto text-ink-faint">{f.path ? 'On disk' : `${formatBytes(f.bytes)}${f.gated ? ', gated' : ''}`}</span>
      </li>)}
    </ul>
    {!status.ready && <button className="btn btn-outline mt-2 py-1 text-[12px]" disabled={fetching} onClick={() => void download()}>
      {fetching ? 'Downloading… progress is under Downloads' : `Download required files (${formatBytes(status.missingBytes)})`}
    </button>}
  </div>;
}

/**
 * An image model's setup in Model Server: its companion files and memory
 * settings. Generating happens in chat (an Image chat), where prompts and
 * pictures stay together as a history; this panel opens one on this model.
 */
export function ImageGeneration({ model, onChanged }: { model: LocalModel; onChanged: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const newImageChat = useStore(s => s.newImageChat);
  const [paths, setPaths] = useState(model.preset?.diffusion ?? {});
  const [defaults, setDefaults] = useState<ImageCompanionStatus['defaults'] | null>(null);
  const save = async () => {
    await window.nekko.engineSaveModelPreset(model.id, { ...model.preset, diffusion: paths });
    onChanged();
  };
  const openChat = async () => {
    try {
      await save();
      await newImageChat(model.id, defaults ?? undefined);
    } catch (e) { pushToast('error', (e as Error).message); }
  };
  return <div className="mt-3 space-y-3 border-t border-line py-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-[13px] font-semibold">{model.name}</h3>
      <button className="btn btn-primary ml-auto py-1 text-[12px]" onClick={() => void openChat()}>Generate in chat</button>
    </div>
    <ImageCompanions model={model} onChanged={onChanged} onDefaults={setDefaults} />
    <details><summary className="cursor-pointer text-[12px] text-ink-soft">Companion files and memory settings</summary>
      <p className="mt-2 text-[12px] text-ink-faint">Use absolute paths on the machine running Nekko. These override the downloaded companions above. Files beside the model named like clip_l.safetensors or vae-*.safetensors are detected automatically.</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{(['clip_l', 'clip_g', 't5xxl', 'vae', 'llm', 'taesd'] as const).map(key => <label key={key} className="text-[12px]">{key}<input className="input mt-1 w-full" value={paths[key] ?? ''} onChange={e => setPaths({ ...paths, [key]: e.target.value || undefined })} /></label>)}</div>
      <div className="mt-3 space-y-2 text-[12px]">
        <label className="flex gap-2"><input type="checkbox" checked={paths.standalone !== false} onChange={e => setPaths({ ...paths, standalone: e.target.checked })} />Standalone diffusion weights (not a full checkpoint)</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.offloadToCpu ?? false} onChange={e => setPaths({ ...paths, offloadToCpu: e.target.checked })} />Offload weights to CPU when possible</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.clipOnCpu ?? false} onChange={e => setPaths({ ...paths, clipOnCpu: e.target.checked })} />Keep text encoders on CPU</label>
      </div>
      <button className="btn btn-outline mt-3 py-1 text-[12px]" onClick={() => void save().then(() => pushToast('success', 'Image settings saved.')).catch(e => pushToast('error', e.message))}>Save image settings</button>
    </details>
  </div>;
}
