import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ModelsWorkspace } from '../src/renderer/views/ModelsWorkspace';
import type { AppSettings, LocalModel } from '@nekko-agent/shared';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

Object.assign(window, { nekkoChrome: { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {} } });

// Rows as the engine lists them for one machine, under three engines. `before` is what the listing was
// before the engine gave its verdict (a fit on every row, `type 143` as a quantization).
const repo = 'prism-ml/Ternary-Bonsai-2-27B-gguf';
const row = (id: string, data: Partial<LocalModel>): LocalModel & { loaded: boolean } => ({ id, path: `/fixture/${id}`, name: id, loaded: false, sizeBytes: 0, managed: false, folderProvider: 'lmstudio', modality: 'chat', ...data });
const ptq1 = { name: 'Ternary-Bonsai-2-27B-PTQ1_0', sourceRepo: repo, modality: 'vision' as const, hasProjector: true, parameterSize: '27B', sizeBytes: 5.9 * 1024 ** 3, maxContext: 262144, unknownWeightType: 143, minEngineBuild: 11556 };
const hadamard = { name: 'Ternary-Bonsai-2-27B-Q2_0', sourceRepo: repo, modality: 'vision' as const, hasProjector: true, parameterSize: '27B', quantization: 'Q2_0', sizeBytes: 7.1 * 1024 ** 3, maxContext: 262144, minEngineBuild: 11556 };
const qwen = { name: 'Qwen3.5-9B-Q4_K_M', quantization: 'Q4_K_M', parameterSize: '9B', sizeBytes: 5.7 * 1024 ** 3, maxContext: 262144 };
const wordsOld = 'Ternary-Bonsai-2-27B-Q2_0 needs llama.cpp b11556 or newer. Older builds load it without an error and give wrong output. The engine is too old for this file: it is b11224.';
const format = 'Ternary-Bonsai-2-27B-PTQ1_0 stores its weights in a format llama.cpp does not know (GGUF tensor type 143).';
const scenarios: Record<string, Array<LocalModel & { loaded: boolean }>> = {
  before: [
    row('ptq1', { ...ptq1, quantization: 'type 143', gpuFit: 'partial', gpuFitIdle: 'partial' }),
    row('q2', { ...hadamard, gpuFit: 'full' }),
    row('qwen', { ...qwen, gpuFit: 'full' }),
  ],
  managed: [
    row('ptq1', { ...ptq1, quantization: 'PTQ1_0', loadCheck: { level: 'blocked', cause: 'weightFormat', reason: `${format} It needs a modified build of llama.cpp, which the engine Nekko Agent installs is not. To run it, point Nekko Agent at a llama-server built for it.` } }),
    row('q2', { ...hadamard, loadCheck: { level: 'blocked', cause: 'engineAge', reason: wordsOld } }),
    row('qwen', { ...qwen, gpuFit: 'full' }),
  ],
  external: [
    row('ptq1', { ...ptq1, quantization: 'PTQ1_0', gpuFit: 'partial', gpuFitIdle: 'partial', loadCheck: { level: 'warning', cause: 'weightFormat', reason: `${format} It needs a modified build of llama.cpp: if your llama-server is not one, loading will fail. Ternary-Bonsai-2-27B-PTQ1_0 needs llama.cpp b11556 or newer. Older builds load it without an error and give wrong output. The version of the engine could not be read, so check that it is b11556 or newer.` } }),
    row('q2', { ...hadamard, gpuFit: 'full', loadCheck: { level: 'warning', cause: 'engineAge', reason: 'Ternary-Bonsai-2-27B-Q2_0 needs llama.cpp b11556 or newer. Older builds load it without an error and give wrong output. The version of the engine could not be read, so check that it is b11556 or newer.' } }),
    row('qwen', { ...qwen, gpuFit: 'full' }),
  ],
};
let current = 'managed';
let saved = { providers: [], onboarded: true, voice: { enabled: true, engine: 'apple' } } as AppSettings;
const bridge = {
  engineStatus: async () => ({ install: { binPath: '/fixture/llama-server', source: current === 'external' ? 'external' : 'managed', available: [] }, running: true, resident: [], loading: [], log: [], settings: { port: 11500, autoStart: true, autoload: [], bind: 'local' }, memory: { kind: 'vram', budgetBytes: 12 * 1024 ** 3 } }),
  engineModels: async () => scenarios[current].map(m => ({ ...m })), engineDownloads: async () => [], engineCatalog: async () => [],
  voiceStatus: async () => ({ engine: 'apple', supported: false, apple: { supported: true, installed: true, installing: false, locale: 'en-US' }, whisper: { installed: false, installing: false, progress: 0 } }),
  decisionsCatalog: async () => [], decisionsModels: async () => [], listProviders: async () => [],
  machineRecommendations: async () => null,
  getSettings: async () => ({ ...saved }), updateSettings: async (patch: Partial<AppSettings>) => (saved = { ...saved, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return Reflect.get(t, k); if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
const root = createRoot(document.getElementById('root')!);
const mount = (scenario: string) => { current = scenario; useStore.setState({ settings: { ...saved }, view: 'models', activeModelId: 'cloud-fixture' }); root.render(<ModelsWorkspace key={scenario} />); };
Object.assign(window, { fixture: { mount, theme: (theme: 'dark' | 'light') => { useStore.setState(state => ({ settings: { ...state.settings!, theme, themePreset: theme === 'dark' ? 'x-plum-dark' : 'x-plum-white' } })); useStore.getState().applyTheme(); } } });
mount('managed');
