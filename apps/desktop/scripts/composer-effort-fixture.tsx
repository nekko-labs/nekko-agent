// Isolated composer evidence with synthetic catalogs; no host or provider calls.
const now = Date.now();
const providers: any[] = [
  { id: 'cloud', kind: 'chatgpt', enabled: true, label: 'ChatGPT (subscription)', auth: 'subscription' },
  { id: 'local', kind: 'lmstudio', enabled: true, label: 'LM Studio', baseUrl: 'http://localhost:1234' },
];
const catalogs: Record<string, any[]> = Object.fromEntries(providers.map(p => [p.id, Array.from({ length: 24 }, (_, i) => ({ id: p.id === 'cloud' ? `gpt-6.1-${i === 0 ? 'sol' : `test-${i}`}` : `local-model-${i}`, providerId: p.id, name: p.id === 'cloud' ? (i === 0 ? 'GPT-6.1-Sol' : `Cloud model ${i}`) : `Local model ${i}`, contextLength: 128000, ...(p.id === 'cloud' ? { effort: { levels: ['low', 'medium', 'high', 'xhigh', 'ultra'].map(effort => ({ effort })), default: 'medium' } } : {}) }))]));
const record: any = { id: 'composer', title: 'Composer choices', createdAt: now, updatedAt: now, providerId: 'cloud', modelId: 'gpt-6.1-sol', mode: 'agent', chatType: 'multimodal', effort: 'medium', messages: [], attachments: [], queuedPrompts: [] };
const settings: any = { providers, defaultProviderId: 'cloud', defaultModelId: 'gpt-6.1-sol', effort: 'medium', workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: { onboarded: true }, onboarded: true };
const bridge: any = {
  getSettings: async () => settings, updateSettings: async (patch: any) => Object.assign(settings, patch),
  listProviders: async () => providers, listModels: async (id: string) => catalogs[id] ?? [],
  getSession: async () => record, setSessionOptions: async (_: string, patch: any) => Object.assign(record, patch),
  listSessionSummaries: async () => [], listTools: async () => [], listInstalledSkills: async () => [], listExternalSkills: async () => [], listSkills: async () => [], listFiles: async () => [], listChanges: async () => [], listShells: async () => [],
  runningSessions: async () => [], pendingInput: async () => ({}), getMcpStatus: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
};
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/ChatPane'), import('../src/renderer/store'), import('../src/renderer/sessionCache')]).then(async ([React, { createRoot }, { ChatPane }, { useStore }, { putCachedSession }]) => {
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  putCachedSession(record);
  useStore.setState({ providers, models: catalogs.cloud, settings, activeSessionId: record.id } as any);
  createRoot(document.getElementById('root')!).render(React.createElement('div', { style: { height: '100vh', padding: 24 } }, React.createElement(ChatPane, { sessionId: record.id, cleanStart: true })));
  (window as any).composerFixture = { record, settings };
});
