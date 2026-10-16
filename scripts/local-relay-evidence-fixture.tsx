import React from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteAccess } from '../apps/desktop/src/renderer/components/RemoteAccess';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic states for Settings → Remote access, picked by `?s=` in the page URL.
// No relay, no Tailscale, no network: every call answers from this table.
const scenario = new URLSearchParams(location.search).get('s') || 'tailscale';
const tailnet = { tailnetIp: '100.101.102.103', tailnetName: 'studio.tail1234.ts.net' };
const relays: Record<string, object> = {
  tailscale: { available: true, running: false, enabled: false, port: 4400, ...tailnet },
  running: { available: true, running: true, enabled: true, port: 4400, ...tailnet, url: 'ws://studio.tail1234.ts.net:4400' },
  'no-tailscale': { available: true, running: false, enabled: false, port: 4400, error: "Tailscale isn't connected on this computer." },
  'in-use': { available: true, running: true, enabled: true, port: 4400, ...tailnet, url: 'ws://studio.tail1234.ts.net:4400' },
};
const remote =
  scenario === 'in-use'
    ? { enabled: true, online: true, relayUrl: 'ws://studio.tail1234.ts.net:4400', room: 'a1b2c3d4e5f60718', devices: [{ id: 'd1', name: 'iPhone', platform: 'ios', pairedAt: 0, lastSeenAt: Date.now() - 60e3 }], connected: ['d1'] }
    : { enabled: false };
const bridge: Record<string, unknown> = {
  getRemoteStatus: async () => remote,
  localRelayStatus: async () => relays[scenario],
  getRemotePairing: async () => null,
};
Object.assign(window, {
  nekko: new Proxy(bridge, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k.startsWith('on')) return () => () => {};
      return () => Promise.resolve(null);
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box' }}>
    <div data-shot="remote" style={{ width: 'min(720px, 100%)', paddingBottom: 4 }}>
      <RemoteAccess />
    </div>
  </main>,
);
