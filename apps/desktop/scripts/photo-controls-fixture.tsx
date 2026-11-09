// Real Photo controls/model details against a synthetic bridge. No downloads or inference.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '../src/renderer/styles.css';
const model: any = { id: 'klein', name: 'FLUX.2 klein 4B', path: '/fixtures/klein.gguf', modality: 'image', sizeBytes: 2400000000 };
let runtime = false, support = true;
const calls: string[] = [];
const listeners = new Set<() => void>();
const known: any = {
 engineModels: async () => [model],
 engineStatus: async () => ({ diffusionInstall: { binPath: runtime ? '/fixture/sd-server' : undefined, recommended: { id: 'fixture-vulkan' }, available: [] } }),
 engineImageCompanions: async () => ({ setId: 'flux2-klein-4b', label: model.name, ready: support, capabilities: ['create', 'edit'], missingBytes: support ? 0 : 2833494868, defaults: { steps: 4, cfgScale: 1 }, files: [{ role: 'vae', source: 'fixture', bytes: 336213556, path: support ? '/fixture/vae' : undefined }] }),
 engineInstall: async () => { calls.push('install'); if ((window as any).photoFixture.fail) throw Error('Fixture engine unavailable'); runtime = true; return { ok: true, message: 'Ready' }; },
 engineDownloadImageCompanions: async () => { calls.push('support'); support = true; return { ok: true, message: 'Ready' }; },
 engineDownloads: async () => [], onDownloadsUpdated: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, machineRecommendations: async () => ({ imageTasks: [] }),
 setSessionOptions: async (_id: string, patch: any) => { calls.push(JSON.stringify(patch)); return Object.assign(session, patch); },
 engineSaveModelPreset: async () => ({}),
};
const session: any = { id: 'fixture', messages: [], imageParams: { modelId: model.id, width: 1024, height: 1024, steps: 4, cfgScale: 1, seed: -1 } };
(window as any).nekko = new Proxy(known, { get: (t, k: string) => t[k] ?? (k.startsWith('on') ? () => () => {} : async () => null) });
(window as any).photoFixture = { calls, fail: false, missingFiles: () => { support = false; listeners.forEach(cb => cb()); } };
void (async () => {
 const { ImageModeControls } = await import('../src/renderer/components/agent-console/ImageModeControls');
 const { ImageGeneration } = await import('../src/renderer/components/engine/ImageGeneration');
 const { useStore } = await import('../src/renderer/store');
 useStore.setState({ newImageChat: async () => { calls.push('open-chat'); } });
 function Fixture() {
  const [s, setSession] = React.useState({ ...session });
  return <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: '32px 20px' }}><div className="mx-auto max-w-3xl">
   <h1 className="text-xl font-semibold">Photo</h1><p className="mt-2 text-sm text-ink-soft">Describe a picture, or attach a photo and say what to change.</p>
   <section className="card mt-5 p-4"><div className="flex flex-wrap items-start gap-2"><ImageModeControls session={s} onChange={setSession} busy={false} /></div><p className="mt-4 border-t border-line pt-4 text-sm text-ink-faint">A quiet harbour at sunset…</p></section>
   <section className="mt-8"><h2 className="text-base font-semibold">Models · photo model setup</h2><ImageGeneration model={model} onChanged={() => {}} /></section>
   <p className="mt-8 text-xs text-ink-faint">Isolated UI fixture · no real download or image generation</p>
  </div></main>;
 }
 createRoot(document.getElementById('root')!).render(<Fixture />);
})();
