import { useState } from 'react';
import type { LocalModel, ImageCompanionStatus } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { PhotoPackageStatus } from './PhotoPackageStatus.js';

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
      <h3 className="text-sm font-semibold">{model.name}</h3>
      <button className="btn btn-primary ml-auto py-1 text-xs" onClick={() => void openChat()}>Open Photo</button>
    </div>
    <PhotoPackageStatus key={model.id} modelId={model.id} onChanged={onChanged} onDefaults={setDefaults} />
    <details><summary className="cursor-pointer text-xs text-ink-soft">Advanced: custom files and memory</summary>
      <p className="mt-2 text-xs text-ink-faint">Use absolute paths on the machine running Nekko. These override the downloaded companions above. Files beside the model named like clip_l.safetensors or vae-*.safetensors are detected automatically.</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{(['clip_l', 'clip_g', 't5xxl', 'vae', 'llm', 'taesd'] as const).map(key => <label key={key} className="text-xs">{key}<input className="input mt-1 w-full" value={paths[key] ?? ''} onChange={e => setPaths({ ...paths, [key]: e.target.value || undefined })} /></label>)}</div>
      <div className="mt-3 space-y-2 text-xs">
        <label className="flex gap-2"><input type="checkbox" checked={paths.standalone !== false} onChange={e => setPaths({ ...paths, standalone: e.target.checked })} />Standalone diffusion weights (not a full checkpoint)</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.offloadToCpu ?? false} onChange={e => setPaths({ ...paths, offloadToCpu: e.target.checked })} />Offload weights to CPU when possible</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.clipOnCpu ?? false} onChange={e => setPaths({ ...paths, clipOnCpu: e.target.checked })} />Keep text encoders on CPU</label>
      </div>
      <button className="btn btn-outline mt-3 py-1 text-xs" onClick={() => void save().then(() => pushToast('success', 'Image settings saved.')).catch(e => pushToast('error', e.message))}>Save image settings</button>
    </details>
  </div>;
}
