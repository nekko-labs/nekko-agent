import React from 'react';
import { createRoot } from 'react-dom/client';
const DEFAULT_SETTINGS: any = { theme: 'dark', mascotEnabled: true, providers: [], guardrails: [], workspaces: [], connectors: [], prompts: [], favoriteModels: [], mcpServers: [] };
import { SettingsView } from '../src/renderer/views/SettingsView';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { useStore } from '../src/renderer/store';
(window as any).nekko = new Proxy({}, { get: (_t, key) => key === 'updateSettings' ? async (patch: any) => { const settings = { ...useStore.getState().settings!, ...patch }; useStore.setState({ settings }); return settings; } : String(key).startsWith('on') ? () => () => {} : async () => [] });
useStore.setState({ settings: { ...DEFAULT_SETTINGS }, settingsLoaded: true, refreshSettings: async () => {}, refreshProviders: async () => {} });
createRoot(document.getElementById('root')!).render(<UpdateProvider><SettingsView /></UpdateProvider>);
