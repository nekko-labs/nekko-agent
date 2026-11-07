// The full App on a fresh install (no providers, setup never finished), so the
// first-run wizard opens over it. Stub bridge: no network, nekkod or real data.
const screens = { placement: 'empty-first', displays: [{ id: '1', label: '1', bounds: { x: 0, y: 0, width: 1728, height: 1117 }, main: true, primary: true, enabled: true, self: true, scaleFactor: 2 }] };
const current = async () => screens;
const displays = { displayId: null, list: current, toggle: current, setPlacement: current, toggleDesktop: current, setSpacesMode: current, go: async () => 'ok', report: () => {}, claim: async () => 'main', onChange: () => () => {}, onPlaced: () => () => {} };
(window as any).nekkoChrome = { platform: 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {}, serviceControl: async () => ({}), reportNotificationVisibility: () => {}, displays };
const settings: any = { providers: [], workspaceFolders: [], workspaces: [], theme: 'system', mascotEnabled: true, experimental: {}, agent: {} };
const joined: unknown[] = [];
const bridge: any = {
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  getSettings: async () => settings,
  updateSettings: async (p: any) => ({ ...Object.assign(settings, p) }),
  updatesJoin: async (...args: unknown[]) => { joined.push(args); return { ok: true }; },
  listProviders: async () => [], probeProviders: async () => [], listConnectors: async () => [], listRunners: async () => [], listSessionSummaries: async () => [], listModels: async () => [], listTerminals: async () => [],
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [],
  listInstalledSkills: async () => [], listExternalSkills: async () => [], listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
(async () => {
  const [{ createRoot }, React, { App }, { UpdateProvider }] = await Promise.all([import('react-dom/client'), import('react'), import('../src/renderer/App'), import('../src/renderer/components/UpdateBanner')]);
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  createRoot(document.getElementById('root')!).render(React.createElement(UpdateProvider, null, React.createElement(App)));
  (window as any).onboardingFixture = { settings, joined, simple: () => ({ mode: localStorage.getItem('nekko.chatMode'), choices: localStorage.getItem('nekko.simpleChoices') }) };
})();
