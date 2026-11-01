import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { ExternalIcon, ShieldIcon } from '../icons.js';

/**
 * Hypergate, running as a tab in this window.
 *
 * Once the two are paired there is no reason to send someone to a browser (or
 * to a second desktop app) to see which MCP servers are running, so the
 * manager's own web UI is embedded here: the same page the Hypergate desktop
 * window shows, served by the daemon over loopback.
 *
 * Unlike {@link BrowserPane} this has no address bar: the tab is *the manager*,
 * not a browser that happens to start there. What it does need is the offline
 * case, since the daemon can stop while the tab stays open. The pane says so
 * and offers to reconnect rather than leaving a blank frame behind.
 */
export function HypergatePane({ url }: { url: string }) {
  const hypergate = useStore((s) => s.hypergate);
  const refresh = useStore((s) => s.refreshHypergate);
  const connect = useStore((s) => s.connectHypergate);
  const ref = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // The daemon can go away under a tab that is already open (a restart, an
  // upgrade). Watch the load rather than polling: a failed navigation is the
  // signal, and a good one clears it.
  useEffect(() => {
    const el = ref.current as any;
    if (!el) return;
    const onFail = () => setFailed(true);
    const onOk = () => setFailed(false);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('did-finish-load', onOk);
    return () => {
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('did-finish-load', onOk);
    };
  }, []);

  const reload = () => {
    try { (ref.current as any)?.reload(); } catch { /* not attached yet */ }
  };

  const retry = async () => {
    setRetrying(true);
    // Re-probe first: a daemon that came back on the same port only needs the
    // frame reloading, while a genuinely absent one should say so.
    await refresh();
    if (useStore.getState().hypergate) { setFailed(false); reload(); } else { await connect(); }
    setRetrying(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1">
        <ShieldIcon className="h-3.5 w-3.5 text-accent" />
        <span className="text-xs font-medium">Hypergate</span>
        {hypergate && (
          <span className="text-xs text-ink-faint">
            v{hypergate.version} · {hypergate.servers} server{hypergate.servers === 1 ? '' : 's'}
            {hypergate.agent ? ` · connected as ${hypergate.agent}` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Reload" onClick={reload}>⟳</button>
          <button
            className="rounded-sm p-1 text-ink-faint hover:text-ink"
            title="Open in external browser"
            onClick={() => window.nekko.openPath(url)}
          >
            <ExternalIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {failed ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <p className="text-sm font-medium">Hypergate isn't answering</p>
              <p className="mt-1 text-xs text-ink-faint">
                The daemon on <code>{url}</code> stopped or restarted. Its tools stay configured; they come back when it does.
              </p>
              <button className="btn btn-outline mt-3 py-1 text-xs" onClick={() => void retry()} disabled={retrying}>
                {retrying ? 'Reconnecting…' : 'Reconnect'}
              </button>
            </div>
          </div>
        ) : (
          <webview ref={ref as any} src={url} style={{ width: '100%', height: '100%' }} />
        )}
      </div>
    </div>
  );
}
