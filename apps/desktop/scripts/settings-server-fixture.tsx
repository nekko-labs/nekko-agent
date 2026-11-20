import './wall-polish-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { SettingsView } from '../src/renderer/views/SettingsView';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or a server.
const apiServer = {
  available: true, running: true, requests: 4, clients: 1, clientUrl: 'http://127.0.0.1:1439',
  settings: { enabled: true, startOnLaunch: true, bind: 'local', port: 1439, token: 'fixture-token-not-a-secret' },
};
const bridge: any = {
  apiServerStatus: async () => apiServer,
  cliInstallStatus: async () => ({ available: true, installed: true, onPath: true, command: 'nekko-agent', binDir: 'C:\\fixture\\bin' }),
  detectAgentTools: async () => [
    { id: 'claude-code', label: 'Claude Code', detected: true, installed: true },
    { id: 'codex', label: 'Codex', detected: true, installed: false },
  ],
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }),
  getSettings: async () => useStore.getState().settings,
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

const settings = { providers: [], workspaceFolders: [], workspaces: [], monitors: {}, theme: 'dark', experimental: {}, agent: {}, ui: {}, guardrails: [], hooks: [], sidebarViews: {} };
useStore.setState({ view: 'settings', providers: [], models: [], sessions: [], terminals: [], workspaces: [], computers: [], settings, refreshSettings: async () => {} } as any);

function Fixture() {
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper">
    <main style={{ flex: 1, minHeight: 0 }}><SettingsView /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
