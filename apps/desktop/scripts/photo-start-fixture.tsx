// A new Photo chat in a focused wall window: the real ChatPane against a stub
// bridge. `localStorage['fixture.photo']` picks the machine before a reload:
// `ready` (two picture models on disk), `none` (no picture model yet, an RTX
// 4060) or `downloading` (the pick's weights coming down). Never contacts a host.
const now = Date.now();
const GB = 1e9;
const mode = localStorage.getItem('fixture.photo') ?? 'ready';
// 'plain': the chat on its own (not a wall window), which keeps the transcript welcome.
const plain = localStorage.getItem('fixture.plain') === '1';
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'ChatGPT (subscription)', auth: 'subscription', tokenKey: 'fixture' };
const chatModel = { id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 };
const record: any = { id: 'photo', title: 'Photo', createdAt: now, updatedAt: now, providerId: 'fixture', modelId: 'gpt-fixture', mode: 'agent', chatType: 'image', messages: [], attachments: [], queuedPrompts: [], imageParams: mode === 'ready' ? { modelId: 'flux', width: 1024, height: 1024, steps: 4, cfgScale: 1, seed: -1 } : {} };
const settings: any = { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', themePreset: 'x-plum-dark', experimental: {}, agent: {}, ui: { onboarded: true }, onboarded: true, firstPromptIntroSeen: true, showTips: false, commandWall: { zonesIntro: true } };
const pictures = [
  { id: 'flux', name: 'flux-2-klein-9b-Q8_0', path: '/models/image/flux-2-klein-9b-Q8_0.gguf', modality: 'image', sizeBytes: 9.8 * GB, quantization: 'Q8_0' },
  { id: 'sd35', name: 'sd3.5_large-Q8_0', path: '/models/image/sd3.5_large-Q8_0.gguf', modality: 'image', sizeBytes: 8.9 * GB, quantization: 'Q8_0' },
];
const option = (o: Record<string, unknown>) => ({ owner: 'Tongyi-MAI', license: 'Apache-2.0', capabilities: ['create'], placement: 'gpu', offloadToCpu: false, headroomBytes: 0, ...o });
// The RTX 4060 8 GB picks from crates/nekko-machine/tests/recommend.rs, with the feed's real sizes.
const options = [
  option({ modelId: 'z-image-turbo', name: 'Z-Image Turbo', repo: 'leejet/Z-Image-Turbo-GGUF', companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'], weightsBytes: 3.86 * GB, companionBytes: 2.83 * GB, downloadBytes: 6.70 * GB, memoryBytes: 6.0 * GB, offloadToCpu: true, fit: 'tight' }),
  option({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', owner: 'Black Forest Labs', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q4_0', downloadLabel: 'Q4_0', files: ['flux-2-klein-4b-Q4_0.gguf'], weightsBytes: 2.46 * GB, companionBytes: 2.83 * GB, downloadBytes: 5.29 * GB, memoryBytes: 4.6 * GB, offloadToCpu: true, fit: 'fits' }),
  option({ modelId: 'qwen-image', name: 'Qwen Image', owner: 'Qwen', repo: 'QuantStack/Qwen-Image-GGUF', companionSet: 'qwen-image', quant: 'Q4_K_M', downloadLabel: 'Q4_K_M', files: ['Qwen_Image-Q4_K_M.gguf'], weightsBytes: 13.07 * GB, companionBytes: 4.94 * GB, downloadBytes: 18.0 * GB, memoryBytes: 15.2 * GB, fit: 'tooBig' }),
];
const recs = {
  feedVersion: '2026-11-08.1',
  hardware: { device: 'NVIDIA GeForce RTX 4060', classId: 'nvidia-rtx-4060', bandwidthGBps: 272, backend: 'vulkan', memoryBytes: 8 * 2 ** 30 },
  budget: { bytes: 7 * 2 ** 30, placement: 'gpu' }, tasks: [], nudges: [],
  imageTasks: [{ task: 'imageCreate', label: 'Create pictures', capability: 'create', pick: options[0], options }],
};
const jobs = mode === 'downloading'
  ? [{ id: 'm', kind: 'model', label: 'Z-Image Turbo · Q4_K', target: 'z', group: 'g', groupLabel: 'Z-Image Turbo · Q4_K', dest: '/models/image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K.gguf', file: 'z_image_turbo-Q4_K.gguf', state: 'downloading', receivedBytes: 1.6 * GB, totalBytes: 3.86 * GB, bytesPerSecond: 40e6, startedAt: now - 40e3 }]
  : [];
const companions = { label: 'FLUX.2 klein', ready: true, files: [], missingBytes: 0, defaults: { steps: 4, cfgScale: 1 } };
const bridge: any = {
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }),
  getSettings: async () => settings, updateSettings: async (p: any) => ({ ...Object.assign(settings, p) }), listProviders: async () => [provider],
  listSessionSummaries: async () => [], listRunners: async () => [], getSession: async () => record, listModels: async () => [chatModel],
  listTerminals: async () => [], listSkillSources: async () => [], skillTargets: async () => [], listConnectors: async () => [], getMessagingStatus: async () => ({}),
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [],
  listInstalledSkills: async () => [], listExternalSkills: async () => [], listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [], getUsageSummary: async () => null,
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  setSessionOptions: async (_id: string, patch: any) => { Object.assign(record, patch); return { ...record }; },
  engineStatus: async () => ({ install: { available: [] }, diffusionInstall: mode === 'ready' ? { available: [], binPath: '/engine/sd-server' } : { available: [], recommended: { id: 'sd-vulkan' } }, running: false, resident: [], log: [], port: 11500, settings: {} }),
  engineModels: async () => (mode === 'ready' ? pictures : []),
  engineDownloads: async () => jobs,
  machineRecommendations: async () => recs,
  engineImageCompanions: async () => (mode === 'ready' ? companions : null),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.setItem('nekko.media-intro.image.v1', 'seen');

import('@nekko-agent/shared').then(async ({ summarizeSession }) => {
  const [{ createRoot }, React, { useStore }, { putCachedSession }, { ChatPane }] = await Promise.all([import('react-dom/client'), import('react'), import('../src/renderer/store'), import('../src/renderer/sessionCache'), import('../src/renderer/components/ChatPane')]);
  await import('@fontsource-variable/geist');
  await import('../src/renderer/styles.css');
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.dataset.preset = 'x-plum-dark';
  putCachedSession(record);
  useStore.setState({ providers: [provider], models: [chatModel], sessions: [summarizeSession(record)], settings, activeSessionId: record.id, running: new Set() } as any);
  const el = React.createElement;
  createRoot(document.getElementById('root')!).render(
    el('div', { className: 'command-wall-layout', 'data-wall-layout': 'focus', style: { height: '100vh', display: 'flex', background: 'var(--paper)' } },
      el('div', { className: 'command-wall-window', 'data-wall-selected': true, style: { position: 'relative', flex: 1, display: 'flex', minWidth: 0, width: '100%', height: '100%' } },
        el('div', { className: 'panel', style: { flex: 1, display: 'grid', minWidth: 0, height: '100%', position: 'relative' } },
          el(ChatPane, plain ? { sessionId: record.id } : { sessionId: record.id, commandCenter: true, surface: 'full', cleanStart: true, status: 'idle', selected: true })))));
  (window as any).photoStart = { record };
});
