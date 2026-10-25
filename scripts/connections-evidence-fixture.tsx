import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSettings, ConnectionEvent } from '@nekko-agent/shared';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ConnectionsSettings } from '../apps/desktop/src/renderer/components/ConnectionsSettings';
import '../apps/desktop/src/renderer/styles.css';

// A day of plausible activity, no backend.
const now = Date.now();
const min = 60_000;
const status = (allOff: boolean) => ({
  allOff,
  connections: [
    { id: 'updates', lastAt: now - 4 * 3600_000, count24h: 1, errors24h: 0, blocked24h: 0 },
    { id: 'model-lists', lastAt: now - 2 * 3600_000, count24h: 8, errors24h: 0, blocked24h: 0 },
    { id: 'cloud-sync', lastAt: now - 40_000, count24h: 1384, errors24h: 3, blocked24h: 0 },
    { id: 'phone-relay', lastAt: now - 12 * min, count24h: 6, errors24h: 1, blocked24h: 0 },
    { id: 'limits', lastAt: now - 25_000, count24h: 2210, errors24h: 0, blocked24h: 0 },
    { id: 'model-providers', lastAt: now - 3 * min, count24h: 312, errors24h: 2, blocked24h: 0 },
    { id: 'github', lastAt: now - 9 * min, count24h: 96, errors24h: 0, blocked24h: 0 },
    { id: 'web-tools', lastAt: now - 50 * min, count24h: 14, errors24h: 1, blocked24h: 0 },
    { id: 'mcp', lastAt: now - 6 * 3600_000, count24h: 3, errors24h: 0, blocked24h: 3 },
  ].map((c) => ({ ...c, allowed: !allOff })),
});
const events: ConnectionEvent[] = [
  { at: now - 40_000, id: 'cloud-sync', kind: 'request', method: 'GET', host: 'nekko-agent-api.fly.dev', path: '/v1/sync/changes', status: 200, bytes: 412, ms: 182 },
  { at: now - 100_000, id: 'cloud-sync', kind: 'request', method: 'POST', host: 'nekko-agent-api.fly.dev', path: '/v1/sync/push', status: 200, bytes: 88, ms: 240 },
  { at: now - 160_000, id: 'cloud-sync', kind: 'request', method: 'GET', host: 'nekko-agent-api.fly.dev', path: '/v1/sync/changes', status: 503, bytes: 56, ms: 1210 },
  { at: now - 220_000, id: 'cloud-sync', kind: 'request', method: 'GET', host: 'nekko-agent-api.fly.dev', path: '/v1/sync/changes', error: 'error sending request: operation timed out' },
  { at: now - 280_000, id: 'cloud-sync', kind: 'request', method: 'GET', host: 'nekko-agent-api.fly.dev', path: '/v1/sync/changes', status: 200, bytes: 0, ms: 171 },
];
let allOff = false;
Object.assign(window, {
  nekko: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'connectionsStatus' || k === 'connectionsClear') return () => Promise.resolve(status(allOff));
      if (k === 'connectionsEvents') return (id: string) => Promise.resolve(events.filter((e) => e.id === id));
      return k.startsWith('on') ? () => () => {} : () => Promise.resolve(null);
    },
  }),
});
try { localStorage.clear(); } catch {}
useStore.setState({ pushToast: () => {} } as any);

function Fixture() {
  const [settings, setSettings] = useState({ connections: { blocked: ['mcp'] } } as unknown as AppSettings);
  const update = (patch: Partial<AppSettings>) => { allOff = patch.connections?.allOff === true; setSettings((s) => ({ ...s, ...patch })); };
  return (
    <main className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
      <div data-evidence="settings" className="mx-auto" style={{ maxWidth: 760 }}>
        <ConnectionsSettings settings={settings} update={update} />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
