// Synthetic full-App fixture for layout evidence. Sets up the desktop chrome
// bridge (macOS) before any renderer module loads; never contacts a host.
(window as any).nekkoChrome = { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {}, serviceControl: async () => ({}), reportNotificationVisibility: () => {} };
const now = Date.now();
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'ChatGPT (subscription)', auth: 'subscription', tokenKey: 'fixture' };
const session = (id: string, title: string, workspaceId?: string) => ({ id, title, createdAt: now, updatedAt: now - 3600e3, providerId: 'fixture', modelId: 'gpt-fixture', mode: 'agent', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] });
const records = [session('a', 'Persist quota history'), session('b', 'Diagnose failed build'), session('c', 'Audit sandbox policy'), session('d', 'New chat')];
const settings = { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: { onboarded: true }, onboarded: true };
const bridge: any = {
  getSettings: async () => settings, updateSettings: async (p: any) => Object.assign(settings, p), listProviders: async () => [provider],
  listSessionSummaries: async () => [],
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }],
  listTerminals: async () => [],
  // A sandbox can seed agent states (localStorage 'fixture.pending' / 'fixture.running') before a reload.
  pendingInput: async () => JSON.parse(localStorage.getItem('fixture.pending') ?? '{}'), runningSessions: async () => JSON.parse(localStorage.getItem('fixture.running') ?? '[]'), listTasks: async () => [],
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [], getUsageSummary: async () => null,
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
import('@nekko-agent/shared').then(async ({ summarizeSession }) => {
  bridge.listSessionSummaries = async () => records.map(summarizeSession);
  const [{ createRoot }, React, { App }, { useStore }, { putCachedSession }, { UpdateProvider }] = await Promise.all([import('react-dom/client'), import('react'), import('../src/renderer/App'), import('../src/renderer/store'), import('../src/renderer/sessionCache'), import('../src/renderer/components/UpdateBanner')]);
  await import('../src/renderer/styles.css');
  records.forEach(putCachedSession);
  document.documentElement.dataset.theme = 'dark';
  createRoot(document.getElementById('root')!).render(React.createElement(UpdateProvider, null, React.createElement(App)));
  (window as any).layoutFixture = { store: useStore };
});
