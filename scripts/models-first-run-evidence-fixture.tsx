import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ModelsWorkspace } from '../apps/desktop/src/renderer/views/ModelsWorkspace';
import fixture from '../apps/desktop/src/renderer/components/engine/recommendations.fixture.json';
import '../apps/desktop/src/renderer/styles.css';

// One machine (an 8 GB RTX 4060), four moments: nothing yet, the engine and a
// model on their way, the model just landed, and a long-time user's library.
const scenario = new URLSearchParams(location.search).get('s') || 'new';
const recs = (fixture as any).rtx4060;
const GB = 1024 ** 3;
const vulkan = { id: 'win-x64-vulkan', platform: 'win32', arch: 'x64', backend: 'vulkan', assetPattern: '', requires: 'Any recent graphics card (NVIDIA, AMD or Intel).' };
const chat = recs.tasks.find((t: any) => t.task === 'chat').pick;
const engineInstalled = scenario !== 'new' && scenario !== 'engine';
const downloaded = scenario === 'ready' || scenario === 'library';
const models = downloaded
  ? [{ id: `${chat.repo}/${chat.files[0]}`, name: chat.name, path: `C:/Users/me/.nekko-agent/models/chat/${chat.repo}/${chat.files[0]}`, sizeBytes: chat.downloadBytes, quantization: chat.quant, parameterSize: '9B', modality: 'chat', managed: true, sourceRepo: chat.repo }]
  : [];
const jobs = scenario === 'engine'
  ? [{ id: 'e', kind: 'engine', label: 'Engine', target: vulkan.id, state: 'downloading', receivedBytes: 12e6, totalBytes: 31e6, bytesPerSecond: 4e6, startedAt: Date.now() }]
  : scenario === 'downloading'
    ? [
        { id: 'e', kind: 'engine', label: 'Engine', target: vulkan.id, state: 'done', receivedBytes: 31e6, totalBytes: 31e6, startedAt: Date.now() - 60e3, finishedAt: Date.now() - 50e3 },
        { id: 'm', kind: 'model', label: chat.name, target: chat.repo, group: 'g', groupLabel: `${chat.name} · ${chat.quant}`, file: chat.files[0], state: 'downloading', receivedBytes: 2.1 * GB, totalBytes: chat.downloadBytes, bytesPerSecond: 22e6, startedAt: Date.now() - 50e3 },
      ]
    : [];
const status = {
  install: engineInstalled ? { binPath: 'C:/llama-server.exe', source: 'managed', backend: 'vulkan', version: 'b7021', available: [vulkan], recommended: vulkan } : { available: [vulkan], recommended: vulkan },
  running: scenario === 'library',
  resident: [],
  loading: [],
  log: [],
  port: 11500,
  settings: { ...DEFAULT_ENGINE_SETTINGS, autoStart: downloaded },
  memory: { budgetBytes: 8 * GB, kind: 'vram' },
  diffusionInstall: { available: [] },
  mlxInstall: { available: [] },
};
const providers = [{ id: 'nekko-engine', kind: 'llamacpp', label: 'Model Server', enabled: true, baseUrl: 'http://127.0.0.1:11500/v1' }];
let modelCalls = 0;
const answers: Record<string, unknown> = {
  engineStatus: status,
  engineModels: models,
  engineCatalogDetail: { id: chat.repo, name: chat.name, owner: 'unsloth', parameterSize: '9B', tags: [], quants: [{ label: chat.quant, file: chat.files[0], sizeBytes: chat.downloadBytes }] },
  engineDownloads: jobs,
  machineRecommendations: recs,
  engineCatalog: [],
  engineFolders: [],
  listProviders: providers,
  listModels: models.map((m) => ({ id: m.id, name: m.name, providerId: 'nekko-engine' })),
  apiServerStatus: { running: false, available: true, settings: { enabled: false, startOnLaunch: true, port: 1440, bind: 'local' } },
  voiceStatus: { installed: false, installing: false, progress: 0, running: false, supported: true, engine: 'whisper', apple: { supported: false, installed: false, installing: false }, whisper: { installed: false, installing: false, progress: 0 } },
  voicePermission: { status: 'unknown', platform: 'win32' },
  decisionsModels: [],
  engineInstallPreview: { runtime: 'diffusion', version: 'master-1a2b', build: vulkan, sizeBytes: 48e6, files: [] },
};
Object.assign(window, {
  nekko: new Proxy({}, {
    get: (_t, k: string) => k.startsWith('on')
      ? () => () => {}
      : () => Promise.resolve(k === 'engineModels' && scenario === 'ready' && modelCalls++ === 0 ? [] : k in answers ? structuredClone(answers[k]) : { ok: true }),
  }),
});
useStore.setState({ view: 'modelserver', providers, settings: { providers } } as any);
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ height: '100vh' }}>
    <ModelsWorkspace />
  </main>,
);
