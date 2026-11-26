import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteAccess } from '../src/renderer/components/RemoteAccess';
import '../src/renderer/styles.css';

// Synthetic Settings → Remote access (TASKS.md IO-19 TS-1). Never connects to a
// host, daemon or relay: every bridge call is faked here and the sandbox
// cancels every non-file request.
const IP = '100.114.173.86';
const NAME = 'gomi.tailfd6474.ts.net';
const TAILNET = `ws://${NAME}:4400`;
const CLOUD = 'wss://nekko-agent-relay.fly.dev';
const PRO = { signedIn: true, account: { email: 'owner@example.com', plan: 'pro', canSync: true, features: { cloudRelay: true } } };
const tailnetUp = { available: true, running: true, enabled: true, port: 4400, tailnetIp: IP, tailnetName: NAME, url: TAILNET };
const phones = [
  { id: 'd1', name: 'iPhone', platform: 'ios', createdAt: Date.now() - 864e5, lastSeenAt: Date.now() - 6e4, route: 'cloud' },
  { id: 'd2', name: 'iPad', platform: 'ios', createdAt: Date.now() - 864e5 * 9, lastSeenAt: Date.now() - 864e5 * 2 },
];
const scenarios: Record<string, { relay: any; remote: any; cloud?: any }> = {
  // Decision 0116 / #3346: tick Tailscale and/or Nekko Cloud Relay.
  'pro-off': { remote: { enabled: false }, relay: tailnetUp, cloud: PRO },
  'pro-both': {
    remote: {
      enabled: true, online: true, relayUrl: TAILNET, alsoRelays: [CLOUD], room: 'fixture-room', connected: ['d1'], devices: phones,
      relays: [{ url: TAILNET, via: 'direct', online: true }, { url: CLOUD, via: 'cloud', online: true }],
    },
    relay: tailnetUp, cloud: PRO,
  },
  'pro-cloud-only': {
    remote: { enabled: true, online: true, relayUrl: CLOUD, room: 'fixture-room', connected: ['d1'], devices: phones, relays: [{ url: CLOUD, via: 'cloud', online: true }] },
    relay: tailnetUp, cloud: PRO,
  },
  'tailnet-idle': {
    remote: { enabled: false },
    relay: { available: true, running: false, enabled: false, port: 4400, tailnetIp: IP, tailnetName: NAME, url: `ws://${NAME}:4400` },
  },
  'tailnet-running': {
    remote: { enabled: false },
    relay: { available: true, running: true, enabled: true, port: 4400, tailnetIp: IP, tailnetName: NAME, url: `ws://${NAME}:4400` },
  },
  // Remote access left on Nekko Cloud while the managed relay is down.
  'cloud-gone': {
    remote: {
      enabled: true, online: false, relayUrl: 'wss://nekko-agent-relay.fly.dev', room: 'fixture-room', connected: [],
      devices: [{ id: 'd1', name: 'iPhone', platform: 'ios', pairedAt: Date.now() - 864e5, lastSeenAt: Date.now() - 864e5 }],
    },
    relay: { available: true, running: false, enabled: false, port: 4400, tailnetIp: IP, tailnetName: NAME, url: `ws://${NAME}:4400` },
  },
  'no-tailscale': {
    remote: { enabled: false },
    relay: { available: true, running: false, enabled: false, port: 4400, error: "Tailscale isn't connected on this computer." },
  },
};
const calls: string[] = [];
let current = scenarios['tailnet-idle'];
const bridge: any = {
  getRemoteStatus: async () => current.remote,
  cloudStatus: async () => current.cloud ?? { signedIn: false },
  securityStatus: async () => ({ enabled: true }),
  setRemoteRelays: async (urls: string[]) => {
    calls.push('remote:setRelays ' + urls.join(' '));
    current = { ...current, remote: { ...current.remote, alsoRelays: urls } };
    return current.remote;
  },
  setRemoteRoute: async (id: string, route: string) => {
    calls.push(`remote:setRoute ${id} ${route}`);
    current = { ...current, remote: { ...current.remote, devices: current.remote.devices.map((d: any) => (d.id === id ? { ...d, route } : d)) } };
    return current.remote.devices;
  },
  localRelayStatus: async () => current.relay,
  localRelayStart: async () => {
    calls.push('localRelay:start');
    current = { ...current, relay: { ...current.relay, running: true, enabled: true } };
    return current.relay;
  },
  localRelayStop: async () => current.relay,
  enableRemote: async (url: string) => {
    calls.push('remote:enable ' + url);
    current = { ...current, remote: { ...current.remote, enabled: true, relayUrl: url, room: 'fixture-room', online: true, devices: current.remote.devices ?? [] } };
    return current.remote;
  },
  disableRemote: async () => {
    calls.push('remote:disable');
    current = { ...current, remote: { enabled: false } };
    return current.remote;
  },
  networkVisibilityStatus: async () => ({ available: true, enabled: false, advertising: false }),
  getPhoneChanges: async () => false,
};
Object.assign(window, {
  nekko: new Proxy(bridge, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key.startsWith('on')) return () => () => {};
      return () => Promise.resolve(null);
    },
  }),
});

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  Object.assign(window, {
    integration: {
      show: (name: string) => {
        current = scenarios[name];
        calls.length = 0;
        setEpoch((e) => e + 1);
      },
      calls,
    },
  });
  return (
    <div className="bg-paper" style={{ minHeight: '100vh', padding: 20 }} key={epoch}>
      <RemoteAccess />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
