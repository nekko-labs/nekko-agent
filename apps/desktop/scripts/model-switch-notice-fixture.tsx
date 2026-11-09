// Real chat/settings surfaces with synthetic data, no host or provider access.
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider' };
const initialSettings: any = { providers: [provider], workspaces: [], theme: 'dark', guardrails: [], experimental: {}, agent: {}, ui: { onboarded: true }, onboarded: true, firstPromptIntroSeen: true, showTips: false };
const records: any[] = [{ id: 'a', title: 'Project review', createdAt: 1, updatedAt: 2, providerId: 'fixture', modelId: 'first', messages: [], attachments: [], queuedPrompts: [] }];
const bridge: any = {
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  getSettings: async () => initialSettings, listProviders: async () => [provider],
  getSession: async () => records[0], listSessionSummaries: async () => [],
  listTasks: async () => [], listInstalledSkills: async () => [], listExternalSkills: async () => [],
  listTools: async () => [], getMcpStatus: async () => [], listShells: async () => [],
  listChanges: async () => [], listFiles: async () => [], getUsageSummary: async () => null,
};
(window as any).nekkoChrome = { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {} };
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });
(async () => {
  const [{ createRoot }, React, { ChatPane }, { SettingsView }, { UpdateProvider }, { useStore }, { putCachedSession }] = await Promise.all([
    import('react-dom/client'), import('react'), import('../src/renderer/components/ChatPane'),
    import('../src/renderer/views/SettingsView'), import('../src/renderer/components/UpdateBanner'), import('../src/renderer/store'), import('../src/renderer/sessionCache'),
  ]);
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  const f = { bridge, store: useStore, records, putCachedSession, lastSend: undefined as any };
  (window as any).layoutFixture = f;
  bridge.sendChat = async (opts: any) => { f.lastSend = opts; };
  const node = document.createElement('div');
  node.style.height = '100vh';
  document.body.append(node);
  document.getElementById('root')!.style.display = 'none';
  const root = createRoot(node);
  const models = ['first', 'second'].map(id => ({ id, providerId: 'fixture', name: `${id} model`, contextWindow: 500000, effort: { levels: [{ effort: 'low' }, { effort: 'high' }], default: 'low' } }));
  let settings = { ...initialSettings, theme: 'dark', expertMode: true, developer: { serverControls: true }, ...JSON.parse(localStorage.getItem('notice-settings') || '{}') };
  f.bridge.getSettings = async () => settings;
  f.bridge.updateSettings = async (patch: any) => {
    if ((window as any).noticeFixture.failSave) throw Error('Synthetic save failure');
    settings = { ...settings, ...patch };
    localStorage.setItem('notice-settings', JSON.stringify(settings));
    return settings;
  };
  f.bridge.listModels = async () => models;
  f.bridge.setSessionOptions = async (id: string, patch: any) => Object.assign(f.records.find((s: any) => s.id === id), patch);
  f.bridge.previewContext = async () => (window as any).noticeFixture.noEstimate ? null : ({ items: [{ id: 'history', included: true, tokens: 106143, source: 'conversation', label: 'History', content: '' }], totalTokens: 106143, budget: 500000 });
  let mount = 0;
  (window as any).noticeFixture = {
    failSave: false, noEstimate: false,
    chat: (empty = false) => {
      const record = f.records[0];
      Object.assign(record, { modelId: 'first', autoModel: false, messages: empty ? [] : [
        { id: 'u', role: 'user', content: 'Review the project and explain the next steps.', createdAt: 1 },
        { id: 'a', role: 'assistant', content: 'The project review is saved in this chat.', createdAt: 2 },
      ] });
      f.putCachedSession(record);
      f.store.setState({ settings, providers: settings.providers, models, activeSessionId: 'a', running: new Set() });
      root.render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { key: ++mount, sessionId: 'a' })));
    },
    settings: () => root.render(React.createElement(UpdateProvider, null, React.createElement(SettingsView))),
    saved: () => settings,
  };
  f.store.setState({ settings });
  (window as any).noticeFixture.chat();
})();
