import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ModelsWorkspace } from '../src/renderer/views/ModelsWorkspace';
import type { AppSettings, GpuFit, LocalModel } from '@nekko-agent/shared';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

Object.assign(window, { nekkoChrome: { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {} } });

const local = (id: string, data: Partial<LocalModel> & { gpuFit?: GpuFit }): LocalModel & { loaded: boolean; gpuFit?: GpuFit } => ({ id, path: `/fixture/${id}`, name: id, loaded: false, sizeBytes: 0, addedAt: 0, managed: true, ...data });
const initial = [
  local('gemma', { name: 'Gemma-4-E4B-Q4_K_M', parameterSize: '7.5B', quantization: 'Q4_K_M', modality: 'vision', hasProjector: true, sizeBytes: 5 * 1024 ** 3, addedAt: 500, gpuFit: 'full', maxContext: 262144 }),
  local('qwen', { name: 'Qwen3.5-9B-Q4_K_M', modality: 'chat', sizeBytes: 6.1 * 1024 ** 3, addedAt: 400, gpuFit: 'partial', managed: false, folderProvider: 'lmstudio' }),
  local('qwen-f16', { name: 'Qwen3.5-9B-F16', modality: 'chat', sizeBytes: 18 * 1024 ** 3, addedAt: 300, gpuFit: 'wont' }),
  local('flux', { name: 'FLUX.2-klein-4B', modality: 'image', sizeBytes: 3 * 1024 ** 3, addedAt: 200 }),
  local('bge', { name: 'BGE Small', parameterSize: '33M', modality: 'embedding', sizeBytes: 67 * 1024 ** 2, addedAt: 100, gpuFit: 'cpu', managed: false, folderProvider: 'lmstudio' }),
];
let models = [...initial];
let saved = { providers: [], onboarded: true, favoriteModels: ['cloud::other'], defaultProviderId: 'cloud', defaultModelId: 'other', voice: { enabled: true, engine: 'apple' } } as AppSettings;
const deleted: string[] = [];
const confirmations: (string | undefined)[] = [];
const loaded: string[] = [];
const autoload = new Set<string>();
const bridge = {
  engineStatus: async () => ({ install: { binPath: '/fixture/llama-server', available: [] }, running: true, resident: [], loading: [], log: [], settings: { port: 11500, autoStart: true, autoload: [...autoload], bind: 'local' }, memory: { kind: 'unified', budgetBytes: 48 * 1024 ** 3 } }),
  engineModels: async () => [...models], engineDownloads: async () => [], engineCatalog: async () => [],
  runtimeLoad: async (providerId: string, id: string) => { loaded.push(`${providerId}::${id}`); return { ok: true }; },
  engineSetAutoload: async (id: string, on: boolean) => { if (on) autoload.add(id); else autoload.delete(id); return { ok: true }; },
  engineDeleteModel: async (id: string, confirmedPath?: string) => { confirmations.push(confirmedPath); deleted.push(id); models = models.filter(m => m.id !== id); return { ok: true, message: 'Deleted from disk.' }; },
  voiceStatus: async () => ({ engine: 'apple', supported: false, apple: { supported: true, installed: true, installing: false, locale: 'en-US' }, whisper: { installed: false, installing: false, progress: 0 } }),
  decisionsCatalog: async () => [], decisionsModels: async () => [], listProviders: async () => [],
  machineRecommendations: async () => null,
  getSettings: async () => ({ ...saved }), updateSettings: async (patch: Partial<AppSettings>) => (saved = { ...saved, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return Reflect.get(t, k); if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
const root = createRoot(document.getElementById('root')!);
const mount = (empty = false) => { if (empty) models = []; useStore.setState({ settings: { ...saved }, view: 'models', activeModelId: 'cloud-fixture' }); root.render(<ModelsWorkspace key={String(empty)}/>); };
Object.assign(window, { fixture: { mount, deleted, confirmations, loaded, skipDeletePrompt: () => { useStore.setState({ settings: { ...saved, skipDeleteConfirmation: true } }); }, autoload: () => [...autoload], saved: () => saved, theme: (theme: 'dark' | 'light') => { useStore.setState(state => ({ settings: { ...state.settings!, theme, themePreset: theme === 'dark' ? 'x-plum-dark' : 'x-plum-white' } })); useStore.getState().applyTheme(); } } });
mount();
