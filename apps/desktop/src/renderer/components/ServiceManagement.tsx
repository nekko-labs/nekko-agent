import { useEffect, useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { windowChrome } from '../chrome.js';
import type { ServiceStatus } from '../../engineChannels.js';
import { UpdateProgress, useUpdater, type UpdaterState } from './UpdateBanner.js';
import { StatusDot } from './primitives/index.js';
import { SettingsSection } from './SettingsSection.js';

export const phoneManagementPatch = (value: boolean): Partial<AppSettings> => ({ manageServiceFromPhone: value });

/** Local shell controls do not depend on the phone management permission. */
export function ServiceManagement({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const updater = useUpdater();

  useEffect(() => {
    let disposed = false;
    if (windowChrome) void windowChrome.serviceControl('status').then(value => {
      if (!disposed) setStatus(value);
    }).catch(() => { if (!disposed) setError('Could not read service status.'); });
    return () => { disposed = true; };
  }, []);

  const restart = async () => {
    if (!windowChrome) return;
    setConfirming(false);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await windowChrome.serviceControl('restart');
      setStatus(result);
      setNotice(result.agentRunning ? 'Service restarted and running.' : 'Restart requested; service is not running. Check the supervisor.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restart the service.'); }
    finally { setBusy(false); }
  };

  return <ServiceManagementView supported={Boolean(windowChrome)} status={status} version={updater.app?.version ?? null}
    confirming={confirming} confirmInstall={confirmInstall} busy={busy} error={error} notice={notice} updater={updater}
    manageFromPhone={settings.manageServiceFromPhone === true} onManageFromPhone={value => update(phoneManagementPatch(value))}
    onAsk={() => setConfirming(true)} onCancel={() => setConfirming(false)} onRestart={() => void restart()}
    onAskInstall={() => setConfirmInstall(true)} onCancelInstall={() => setConfirmInstall(false)}
    onInstall={() => { setConfirmInstall(false); void updater.install(); }} />;
}

export function ServiceManagementView({ supported, status, version, confirming, confirmInstall, busy, error, notice, updater, manageFromPhone, onManageFromPhone, onAsk, onCancel, onRestart, onAskInstall, onCancelInstall, onInstall }: {
  supported: boolean; status: ServiceStatus | null; version: string | null; confirming: boolean; confirmInstall: boolean; busy: boolean; error: string; notice: string;
  updater: UpdaterState; manageFromPhone: boolean; onManageFromPhone: (value: boolean) => void;
  onAsk: () => void; onCancel: () => void; onRestart: () => void; onAskInstall: () => void; onCancelInstall: () => void; onInstall: () => void;
}) {
  const { info, stage } = updater;
  const updating = stage === 'checking' || stage === 'downloading' || stage === 'installing';
  return (
    <SettingsSection title="Nekko Agent service" aria-label="Nekko Agent service" help={version ? `App version ${version}` : 'App version unavailable'}>
      {supported ? <>
        <p className="mt-(--q-inline) inline-flex items-center gap-1.5 text-sm text-ink-soft" role="status">
          {status && <StatusDot tone={status.agentRunning ? 'success' : 'neutral'} size={7} />}
          {status ? status.agentRunning ? 'Running' : 'Stopped' : 'Service status unavailable'}
        </p>
        {confirming ? <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
          <p className="text-xs">Restart Nekko Agent service? Running chats may be interrupted. Your computer will not restart.</p>
          <button className="btn btn-primary py-1 text-xs" onClick={onRestart} disabled={busy}>Confirm restart</button>
          <button className="btn btn-ghost py-1 text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        </div> : <div className="mt-(--q-inline)"><button className="btn btn-ghost py-1 text-xs" onClick={onAsk} disabled={busy}>
          {busy ? 'Restarting…' : 'Restart service'}
        </button></div>}
      </> : <p className="mt-(--q-inline) text-xs text-ink-faint">Service restart and desktop update installation are not supported from the Local Web UI. Manage the service with its supervisor or installation method.</p>}
      {notice && <p className="mt-(--q-inline) text-xs" role="status">{notice}</p>}
      {error && <p className="mt-(--q-inline) text-xs text-danger-text" role="alert">{error}</p>}
      <label className="mt-(--q-group) flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline)">
        <span className="min-w-0 text-sm font-medium">Manage service from phone<span className="mt-(--q-tight) block text-xs font-normal text-ink-faint">Allow eligible paired phones to request service and update actions. Separate from permission to quit. Host capabilities and phone permissions still apply.</span></span>
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={manageFromPhone} onChange={event => onManageFromPhone(event.target.checked)} />
      </label>
      <div className="mt-(--q-group)">
        <h3 className="text-sm font-medium">Service updates</h3>
        <p className="mt-(--q-tight) text-xs text-ink-faint" role="status" aria-live="polite">
          {stage === 'checking' ? 'Checking for updates…' : stage === 'downloading' ? `Downloading${info?.percent != null ? `: ${Math.round(info.percent)}%` : '…'}` : stage === 'installing' ? 'Install requested. The app may close; verify the version after reopening.' : stage === 'failed' ? updater.error ?? info?.message ?? 'Update failed.' : info?.state === 'none' ? info.message ?? 'Up to date.' : info?.state === 'downloaded' ? `Ready to install${info.version ? ` v${info.version}` : ''}.` : info?.state === 'available' ? `Update available${info.version ? `: v${info.version}` : ''}.` : info?.message ?? 'No update check yet.'}
        </p>
        {stage === 'downloading' && <div className="mt-(--q-inline) max-w-md"><UpdateProgress percent={info?.percent} /></div>}
        <div className="mt-(--q-inline) flex flex-wrap gap-2">
          <button className="btn btn-ghost py-1 text-xs" onClick={() => void updater.check(true)} disabled={updating}>Check for updates</button>
          {supported && info?.state === 'available' && <button className="btn btn-ghost py-1 text-xs" onClick={() => void updater.downloadOnly()} disabled={updating}>Download update</button>}
          {supported && info?.state === 'downloaded' && !confirmInstall && <button className="btn btn-primary py-1 text-xs" onClick={onAskInstall} disabled={updating}>Install update</button>}
        </div>
        {supported && confirmInstall && <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
          <p className="text-xs">Install the update and restart the app? Running chats may be interrupted.</p>
          <button className="btn btn-primary py-1 text-xs" onClick={onInstall} disabled={updating}>Confirm install</button>
          <button className="btn btn-ghost py-1 text-xs" onClick={onCancelInstall} disabled={updating}>Cancel</button>
        </div>}
        {!supported && <p className="mt-(--q-inline) text-xs text-ink-faint">Desktop installation requires the desktop app and its supervisor; use your web installation method instead.</p>}
      </div>
    </SettingsSection>
  );
}
