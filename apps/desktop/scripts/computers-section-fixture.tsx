// Synthetic evidence fixture for Settings > Computers: one connected computer
// and this computer's own switches. No host, no network.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ComputersSection } from '../src/renderer/components/ComputersSection';
import '../src/renderer/styles.css';

const settings: any = { theme: 'dark', keepAwakeWhileAgentsRun: new URLSearchParams(location.search).get('awake') === '1' };
const bridge: any = {
  listComputers: async () => [{ id: 'gomi', name: 'gomi', state: 'online', color: 0, route: 'ws://100.64.0.7:7881', read: true, change: true }],
  onComputersUpdated: () => () => {},
  updateSettings: async (p: any) => Object.assign(settings, p),
  getSettings: async () => settings,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings, refreshSettings: async () => useStore.setState({ settings: { ...settings } }) } as any);
createRoot(document.getElementById('root')!).render(
  <div style={{ background: 'var(--paper)', color: 'var(--ink)', minHeight: '100vh', padding: 24 }}><div style={{ width: 640 }}><ComputersSection /></div></div>,
);
