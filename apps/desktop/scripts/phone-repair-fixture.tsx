// Real RemoteAccess surface against an in-memory bridge. No host or network.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteAccess } from '../src/renderer/components/RemoteAccess';
import { useStore } from '../src/renderer/store';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import '../src/renderer/styles.css';
const settings: any = { providers: [], machineName: '' };
const status = { enabled: true, online: true, relayUrl: 'wss://relay.example', room: '12345678', devices: [{ id: 'phone', name: 'Philip’s iPhone', platform: 'ios', pairedAt: 1, lastSeenAt: Date.now() }], connected: ['phone'] };
const calls: string[] = [];
const bridge: any = {
  getRemoteStatus: async () => status,
  getAppInfo: async () => ({ version: 'fixture', platform: 'darwin', edition: 'desktop', hostname: 'Philip’s MacBook Pro' }),
  getSettings: async () => settings,
  updateSettings: async (patch: any) => Object.assign(settings, patch),
  localRelayStatus: async () => ({ running: false }),
  securityStatus: async () => ({ enabled: true }),
  startRemotePairing: async () => { calls.push('pair'); return { code: 'TEST2345', expiresAt: Date.now() + 300000 }; },
  getRemotePairing: async () => ({ relayUrl: status.relayUrl, room: status.room, key: 'fixture', hostKey: 'fixture' }),
};
(window as any).nekko = new Proxy(bridge, { get: (t, k: string) => k in t ? t[k] : k.startsWith('on') ? () => () => {} : async () => null });
(window as any).phoneRepairFixture = { calls, settings };
useStore.setState({ settings } as any);
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-3xl p-5"><h1 className="text-xl font-semibold">Settings</h1><RemoteAccess /></main>);
