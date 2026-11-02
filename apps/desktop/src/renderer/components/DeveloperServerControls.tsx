import { useEffect, useState } from 'react';
import { windowChrome } from '../chrome.js';
import { useStore } from '../store.js';
import type { ServiceAction, ServiceStatus } from '../../engineChannels.js';

/** Shell IPC stays available even when the agent server is switched off. */
export function DeveloperServerControls() {
  const enabled = useStore(s => s.settings?.developer?.serverControls === true);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !windowChrome) return;
    let disposed = false;
    const refresh = () => windowChrome!.serviceControl('status').then(s => {
      if (!disposed) setStatus(s);
    }).catch(() => { if (!disposed) setStatus(null); });
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => { disposed = true; clearInterval(timer); };
  }, [enabled]);
  if (!enabled || !windowChrome) return null;
  const run = async (action: ServiceAction) => {
    setBusy(true);
    setError('');
    try { setStatus(await windowChrome!.serviceControl(action)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Service action failed'); }
    finally { setBusy(false); }
  };
  return (
    <div className="developer-server-controls no-drag" aria-label="Developer server controls">
      <button className="btn btn-outline px-2! py-1! text-2xs" role="switch" aria-checked={status?.agentRunning ?? false} disabled={busy || !status}
        title="Start or stop the agent server" onClick={() => void run(status?.agentRunning ? 'stop' : 'start')}>
        Agent: {status ? status.agentRunning ? 'On' : 'Off' : '…'}
      </button>
      <button className="btn btn-outline px-2! py-1! text-2xs" role="switch" aria-checked={status?.modelRunning ?? false}
        disabled={busy || !status?.agentRunning || (!status.modelRunning && !status.modelAvailable)}
        title="Start or stop the model server (requires an installed runtime and the agent server)"
        onClick={() => void run(status?.modelRunning ? 'model-stop' : 'model-start')}>
        Model: {status?.modelRunning ? 'On' : 'Off'}
      </button>
      <button className="btn btn-outline px-2! py-1! text-2xs" disabled={busy} title="Restart the agent server without closing the app" onClick={() => void run('restart')}>
        {busy ? 'Working…' : 'Restart server'}
      </button>
      {error && <span className="text-2xs text-danger" role="alert" title={error}>{error}</span>}
    </div>
  );
}
