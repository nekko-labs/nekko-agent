import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { notificationSessionId } from '../notifications.js';
import { hypergateConnectPort } from '../deepLinks.js';
import { Modal } from './primitives/index.js';

/**
 * `nekko-agent://` links from other apps.
 *
 * One route today: `nekko-agent://hypergate/connect?port=7777`, which is what
 * Hypergate's "Connect Nekko Agent" button fires. The link is a *request*, never
 * the action: any program on the machine can open a URL, and connecting a
 * gateway means trusting whatever tools it offers in every chat from then on.
 * So the link brings the window forward, names what is asking, and waits for a
 * click. Everything it shows is read back from the daemon itself rather than
 * taken from the URL, which carries nothing but a port.
 */

/** What a link asked for, once we've checked there's really a daemon there. */
interface Ask {
  port: number;
  version: string;
  servers: number;
  /** Already in this install's MCP list, so this is a re-connect. */
  known: boolean;
}

export function DeepLinkListener() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = window.nekko.onDeepLink((url) => {
      if (url === 'nekko-agent://chat/new') {
        void useStore.getState().newChat().catch(e => useStore.getState().pushToast('error', e.message));
        return;
      }
      // Notification links are handled by the notification listener.
      if (notificationSessionId(url)) return;
      const port = hypergateConnectPort(url);
      const { pushToast, refreshHypergate, settings } = useStore.getState();
      if (port === null) {
        pushToast('error', `Nekko Agent did not understand that link: ${url}`);
        return;
      }
      void (async () => {
        // Probe before asking: a link pointing at a port with nothing on it
        // should say so, not open a dialog about a daemon that isn't there.
        await refreshHypergate(port);
        const found = useStore.getState().hypergate;
        if (!found) {
          pushToast('error', `Nothing is serving Hypergate on port ${port}.`);
          return;
        }
        setAsk({
          port,
          version: found.version,
          servers: found.servers,
          known: (settings?.mcpServers ?? []).some((s) => s.id === 'hypergate'),
        });
      })();
    });
    return off;
  }, []);

  if (!ask) return null;

  const accept = async () => {
    setBusy(true);
    await useStore.getState().connectHypergate(ask.port);
    setBusy(false);
    setAsk(null);
  };

  const heading = ask.known ? 'Reconnect Hypergate?' : 'Connect Hypergate?';
  return (
    <Modal
      title={heading}
      labelledBy="hypergate-link-title"
      onClose={() => setAsk(null)}
      overlayClassName="p-4"
      className="card w-full max-w-md p-4"
    >
      <div>
        <h2 id="hypergate-link-title" className="text-[15px] font-semibold">{heading}</h2>
        <p className="mt-2 text-[12.5px] text-ink-soft">
          Hypergate v{ask.version} on port {ask.port} is asking to connect to Nekko Agent.{' '}
          {ask.servers === 1
            ? 'The one server it manages becomes a single entry in your MCP list, and its tools are offered in every chat.'
            : `The ${ask.servers} servers it manages become a single entry in your MCP list, and their tools are offered in every chat.`}
        </p>
        <p className="mt-2 text-[11.5px] text-ink-faint">
          Nekko Agent gets its own scoped token, so you can narrow or revoke it from Hypergate at any time.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-outline py-1 text-[12px]" onClick={() => setAsk(null)} disabled={busy}>Not now</button>
          <button className="btn btn-primary py-1 text-[12px]" onClick={() => void accept()} disabled={busy}>
            {busy ? 'Connecting…' : ask.known ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
