import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteAccess } from '../src/renderer/components/RemoteAccess';
import '../src/renderer/styles.css';

// Synthetic Settings → Remote access (TASKS.md IO-19 TS-1). Never connects to a
// host, daemon or relay: every bridge call is faked here and the sandbox
// cancels every non-file request.
const IP = '100.114.173.86';
const NAME = 'gomi.tailfd6474.ts.net';
const scenarios: Record<string, { relay: any; remote: any }> = {
  'tailnet-idle': {
    remote: { enabled: false },
    relay: { available: true, running: false, enabled: false, port: 4400, tailnetIp: IP, tailnetName: NAME, url: `ws://${NAME}:4400` },
  },
  'tailnet-running': {
    remote: { enabled: false },
    relay: { available: true, running: true, enabled: true, port: 4400, tailnetIp: IP, tailnetName: NAME, url: `ws://${NAME}:4400` },
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
  localRelayStatus: async () => current.relay,
  localRelayStart: async () => {
    calls.push('localRelay:start');
    current = { ...current, relay: { ...current.relay, running: true, enabled: true } };
    return current.relay;
  },
  localRelayStop: async () => current.relay,
  enableRemote: async (url: string) => {
    calls.push('remote:enable ' + url);
    return { enabled: true, relayUrl: url, room: 'fixture-room', online: true, devices: [] };
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
