import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import { SettingsView } from '../src/renderer/views/SettingsView';
import { ModelServerView } from '../src/renderer/views/ModelServerView';
import { TitleBar } from '../src/renderer/components/TitleBar';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { useStore } from '../src/renderer/store';
__BOUNDARY_IMPORT__

const defaults = __DEFAULTS__;
let failure = false;
let engineFailure = false;
let crash = false;
let theme = 'system';
const fresh = () => ({ ...structuredClone(defaults), theme });
const engine = { install: { available: [] }, diffusionInstall: { available: [] }, mlxInstall: { available: [] }, running: false, resident: [], loading: [], log: [], settings: DEFAULT_ENGINE_SETTINGS };
(window as any).nekko = new Proxy({
  getSettings: async () => { if (failure) throw new Error('settings:get: the engine restarted before it answered'); return fresh(); },
  updateSettings: async (patch: any) => ({ ...fresh(), ...patch }),
  engineStatus: async () => { if (engineFailure) throw new Error('engine:status: the engine restarted before it answered'); return engine; },
  appInfo: async () => ({ version: '0.8.0', edition: 'desktop', isPackaged: true }),
  apiServerStatus: async () => null,
  voiceStatus: async () => null,
  engineInstallPreview: async () => null,
  hypergateStatus: async () => null,
}, { get(target: any, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return async () => []; } });
const root = createRoot(document.getElementById('root')!);
function Crash() { if (crash) throw new Error('Synthetic render failure'); return <p>Recovered section</p>; }
function show(view: 'settings' | 'modelserver' | 'command' | 'crash', fail = false) {
  failure = view === 'settings' && fail;
  engineFailure = view === 'modelserver' && fail;
  useStore.setState({ view: view === 'crash' ? 'command' : view, settings: failure ? null : fresh(), settingsLoaded: true, settingsError: null, onboardingOpen: false });
  useStore.getState().applyTheme();
  root.render(<UpdateProvider><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <TitleBar />
    <nav><button id="nav-settings" onClick={() => show('settings')}>Settings</button><button id="nav-server" onClick={() => show('modelserver')}>Nekko Server</button></nav>
    <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><Boundary key={view + fail} label="Page">
      {view === 'settings' ? <SettingsView /> : view === 'modelserver' ? <ModelServerView /> : view === 'crash' ? <><Boundary label="Section"><Crash /></Boundary><p id="sibling">Other section remains usable</p></> : <p>Agents</p>}
    </Boundary></main>
  </div></UpdateProvider>);
}
(window as any).__fixture = { show, recover: () => { failure = false; engineFailure = false; crash = false; }, crash: () => { crash = true; show('crash'); }, theme: (value: string) => { theme = value; useStore.setState({ settings: fresh() }); useStore.getState().applyTheme(); } };
show('settings');
