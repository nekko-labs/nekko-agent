import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectorsView } from '../src/renderer/views/ConnectorsView';
import { useStore } from '../src/renderer/store';

// Synthetic state only: no credentials, every host call answers locally.
(window as any).nekko = new Proxy({
  listConnectors: async () => [],
  getMessagingConfig: async () => ({ telegram: { enabled: false, botToken: '', allowedChatIds: [] } }),
  messagingStatus: async () => ({}),
  getSettings: async () => ({ theme: 'dark' }),
}, { get(target: any, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return async () => null; } });

const root = createRoot(document.getElementById('root')!);
function show(theme: 'light' | 'dark') {
  useStore.setState({ view: 'connectors', settings: { theme } as any, settingsLoaded: true, onboardingOpen: false } as any);
  document.documentElement.dataset.theme = theme;
  root.render(<div key={theme} style={{ height: '100vh' }}><ConnectorsView /></div>);
}
(window as any).__fixture = { show };
