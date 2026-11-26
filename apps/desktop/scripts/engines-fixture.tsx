// The Models page with a synthetic model server, for the Engines block:
// `fixture.machine(name)` swaps the computer the engine list is for. No host,
// no network, no real downloads.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ModelsWorkspace } from '../src/renderer/views/ModelsWorkspace';
import type { AppSettings, LocalModel } from '@nekko-agent/shared';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

Object.assign(window, { nekkoChrome: { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {} } });

type Row = { id: string; name: string; detail: string; state: 'usable' | 'unsupported' | 'planned'; reason?: string; labels?: string[]; runtime?: string; installed?: boolean; version?: string; source?: string; inUse?: boolean };
const DETAIL: Record<string, [string, string]> = {
  llama: ['llama.cpp', 'Runs any GGUF model, on every computer.'],
  mlx: ['MLX', "Apple's own framework. Runs MLX models."],
  omlx: ['oMLX', 'MLX with batching and a prompt cache kept on disk.'],
  basalt: ['Basalt', 'Built for RTX 50 series cards. Runs its own model packs.'],
  squid5090: ['squid5090', 'Built for one RTX 5090. Runs Inkling 2 Mini.'],
};
const on = (id: string, more: Partial<Row> = {}): Row => ({ id, name: DETAIL[id][0], detail: DETAIL[id][1], state: 'usable', runtime: id, ...more });
const off = (id: string, reason: string, state: Row['state'] = 'unsupported'): Row => ({ id, name: DETAIL[id][0], detail: DETAIL[id][1], state, reason });
const NOT_BUILT = 'Not in this version of Nekko yet';
const llama = { installed: true, version: 'b12532', source: 'managed' };
/** Each machine's rows as the daemon lists them; the first installed row is in use until one is chosen. */
const MACHINES: Record<string, Row[]> = {
  mac: [on('mlx', { labels: ['fastest', 'stable'], installed: true, version: 'mlx-lm 0.31.3', source: 'managed' }), on('llama', llama), off('omlx', NOT_BUILT, 'planned'), off('basalt', 'NVIDIA RTX 50 series only'), off('squid5090', 'NVIDIA RTX 5090 only')],
  'mac-no-mlx': [on('mlx', { labels: ['fastest', 'stable'] }), on('llama', llama), off('omlx', NOT_BUILT, 'planned'), off('basalt', 'NVIDIA RTX 50 series only'), off('squid5090', 'NVIDIA RTX 5090 only')],
  linux5090: [on('llama', llama), off('omlx', NOT_BUILT, 'planned'), off('basalt', NOT_BUILT, 'planned'), off('squid5090', NOT_BUILT, 'planned'), off('mlx', 'macOS only')].map((r) => r.id === 'omlx' ? off('omlx', 'macOS only') : r),
  windows5090: [on('llama', llama), off('basalt', NOT_BUILT, 'planned'), off('mlx', 'macOS only'), off('omlx', 'macOS only'), off('squid5090', 'Linux only')],
  pc: [on('llama', llama), off('mlx', 'macOS only'), off('omlx', 'macOS only'), off('basalt', 'NVIDIA RTX 50 series only'), off('squid5090', 'NVIDIA RTX 5090 only')],
};
let machine = 'mac';
let chosen: string | undefined;
const saves: unknown[] = [];
const engines = () => {
  const rows = MACHINES[machine];
  const picked = rows.find((r) => r.id === chosen && r.installed) ?? rows.find((r) => r.installed);
  return rows.map((r) => ({ ...r, inUse: r === picked || undefined }));
};
const build = { id: 'macos-arm64-metal', platform: 'darwin', arch: 'arm64', backend: 'metal', assetPattern: 'x', requires: 'An Apple Silicon Mac.' };

const local = (id: string, data: Partial<LocalModel>): LocalModel & { loaded: boolean } => ({ id, path: `/fixture/${id}`, name: id, loaded: false, sizeBytes: 0, addedAt: 0, managed: true, ...data });
const models = [
  local('gemma', { name: 'Gemma-4-E4B-Q4_K_M', parameterSize: '7.5B', quantization: 'Q4_K_M', modality: 'vision', hasProjector: true, sizeBytes: 5 * 1024 ** 3, addedAt: 500, maxContext: 262144 }),
  local('qwen', { name: 'Qwen3.5-9B-Q4_K_M', modality: 'chat', sizeBytes: 6.1 * 1024 ** 3, addedAt: 400 }),
];
let saved = { providers: [], onboarded: true, favoriteModels: [], voice: { enabled: true, engine: 'apple' } } as unknown as AppSettings;
const bridge = {
  engineStatus: async () => ({
    install: { binPath: '/fixture/llama-server', version: 'b12532', source: 'managed', available: [] },
    diffusionInstall: { binPath: '/fixture/sd-server', version: 'master-1086', source: 'managed', available: [build] },
    mlxInstall: { available: machine.startsWith('mac') ? [build] : [] },
    engines: engines(),
    running: true, resident: [], loading: [], log: [], port: 11500,
    settings: { port: 11500, autoStart: true, bind: 'local', jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2, chatEngine: chosen },
    memory: { kind: 'unified', budgetBytes: 48 * 1024 ** 3 },
  }),
  engineSettingsSave: async (patch: { chatEngine?: string }) => { saves.push(patch); if (patch.chatEngine) chosen = patch.chatEngine; return {}; },
  engineInstallPreview: async (runtime: string) => ({ runtime, version: 'mlx-lm 0.31.3 (uv 0.12.21)', build, sizeBytes: 420 * 1024 ** 2, files: [] }),
  engineModels: async () => [...models], engineDownloads: async () => [], engineCatalog: async () => [],
  voiceStatus: async () => ({ engine: 'apple', supported: false, apple: { supported: true, installed: true, installing: false, locale: 'en-US' }, whisper: { installed: false, installing: false, progress: 0 } }),
  decisionsCatalog: async () => [], decisionsModels: async () => [], listProviders: async () => [],
  machineRecommendations: async () => null,
  getSettings: async () => ({ ...saved }), updateSettings: async (patch: Partial<AppSettings>) => (saved = { ...saved, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return Reflect.get(t, k); if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
const root = createRoot(document.getElementById('root')!);
const mount = () => { useStore.setState({ settings: { ...saved }, view: 'models', activeModelId: 'cloud-fixture' }); root.render(<ModelsWorkspace key={machine} />); };
Object.assign(window, { fixture: {
  machine: (name: string) => { machine = name; chosen = undefined; mount(); },
  saves: () => saves,
  theme: (theme: 'dark' | 'light') => { useStore.setState(state => ({ settings: { ...state.settings!, theme, themePreset: theme === 'dark' ? 'x-plum-dark' : 'x-plum-white' } })); useStore.getState().applyTheme(); },
} });
mount();
