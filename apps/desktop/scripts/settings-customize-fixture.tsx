// Real Settings view with synthetic defaults and an in-memory bridge, never a host.
import defaultsFile from '../../../crates/nekko-settings/src/defaults.json';
const settings = { ...defaultsFile.defaults, providers: [], workspaceFolders: [], workspaces: [], firstPromptIntroSeen: true, showTips: false };
const patches: unknown[] = [];
const bridge: Record<string, any> = {
  getSettings: async () => settings,
  getRemoteStatus: async () => ({ enabled: false }),
  telemetryStatus: async () => ({ configured: false }),
  updateSettings: async (patch: unknown) => { patches.push(patch); return { ...Object.assign(settings, patch) }; },
  getAppInfo: async () => ({ version: '0.0.0-settings-fixture', platform: 'win32' }),
};
const lists = new Set(['listProviders', 'listModels', 'listRunners', 'listShells', 'listTools', 'listTerminals', 'getMcpStatus', 'listComputers', 'listWorkspaces']);
(window as any).nekko = new Proxy(bridge, { get(target, key: string) {
  if (key in target) return target[key];
  if (key.startsWith('on')) return () => () => {};
  return async () => lists.has(key) ? [] : null;
} });
(window as any).nekkoChrome = { platform: 'win32', titleBarHeight: 38, setTitleBarOverlay: () => {}, serviceControl: async () => ({}) };
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/views/SettingsView'), import('../src/renderer/store'), import('../src/renderer/components/UpdateBanner')]).then(async ([React, { createRoot }, { SettingsView }, { useStore }, { UpdateProvider }]) => {
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  localStorage.setItem('nekko.chatMode', 'expert');
  useStore.setState({ settings, settingsLoaded: true } as any);
  useStore.getState().applyTheme();
  createRoot(document.getElementById('root')!).render(React.createElement(UpdateProvider, null, React.createElement(SettingsView)));
  (window as any).settingsFixture = { settings, patches };
});
