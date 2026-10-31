import { useCallback, useEffect, useState } from 'react';
import { type CloudStatus, type SyncDevice, cloudError } from '@nekko-agent/shared';
import { Toggle } from '../primitives/Toggle.js';
import { CloudSignIn } from './CloudSignIn.js';
import { RecoveryKeyDialog } from './RecoveryKeyDialog.js';
import { SyncVisual } from './SyncVisual.js';
import './cloud.css';

const PLANS_URL = 'https://nekkoagent.com/pricing';

/** Settings → Sync: Nekko Cloud sign-in and end-to-end encrypted chat sync. */
export function SyncSettings() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [signIn, setSignIn] = useState(false);
  const [recovery, setRecovery] = useState<{ key: string | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    window.nekko.cloudStatus().then((s) => { if (live) setStatus(s); }).catch((e) => setError(cloudError(e)));
    window.nekko.cloudRefresh().then((s) => { if (live) setStatus(s); }).catch(() => {});
    const off = window.nekko.onCloudStatus((s) => { if (live) setStatus(s); });
    return () => { live = false; off(); };
  }, []);

  const act = useCallback(async (label: string, work: () => Promise<CloudStatus | { status: CloudStatus } | unknown>) => {
    setError('');
    setBusy(label);
    try {
      const r = await work();
      if (r && typeof r === 'object' && 'sync' in r) setStatus(r as CloudStatus);
      else if (r && typeof r === 'object' && 'status' in r) setStatus((r as { status: CloudStatus }).status);
    } catch (e) {
      setError(cloudError(e));
      window.nekko.cloudStatus().then(setStatus).catch(() => {});
    } finally {
      setBusy('');
    }
  }, []);

  const turnOn = () => act('on', async () => {
    const r = await window.nekko.syncTurnOn();
    if (r.recoveryKey) setRecovery({ key: r.recoveryKey });
    return r;
  });

  const phase = status?.sync.phase ?? 'signed-out';
  const others = status?.sync.devices.filter((d) => !d.thisDevice && !d.revoked).length ?? 0;
  const pending = status?.sync.devices.filter((d) => !d.trusted && !d.revoked && !d.thisDevice && d.askedToJoin) ?? [];

  return (
    <section id="sync" className="card sync-card mt-5 p-5" aria-label="Sync" data-testid="sync-settings">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Sync</h2>
          <p className="mt-1 text-xs text-ink-faint">Your chats on every device, end-to-end encrypted. Nekko Labs can't read them.</p>
        </div>
        <PhasePill status={status} />
      </div>

      <div className="sync-card-hero mt-4"><SyncVisual phase={phase} others={others} /></div>

      {phase === 'signed-out' && (
        <div className="text-center">
          <p className="mx-auto max-w-md text-sm text-ink-soft">Sign in to Nekko Cloud to keep your chats in step across your computers and your iPhone. Everything is encrypted here before it leaves this computer.</p>
          <button className="btn btn-primary mt-4" onClick={() => setSignIn(true)} data-testid="sync-sign-in">Sign in to Nekko Cloud</button>
        </div>
      )}

      {status?.signedIn && (
        <div className="sync-row">
          <div className="min-w-0 text-sm">
            <div className="truncate text-ink">{status.account?.email}</div>
            <div className="text-xs text-ink-faint">{planLabel(status.account?.plan)}</div>
          </div>
          <button className="btn btn-ghost py-1! text-xs!" disabled={!!busy} onClick={() => void act('out', () => window.nekko.cloudSignOut())}>Sign out</button>
        </div>
      )}

      {phase === 'needs-plan' && (
        <div className="sync-row">
          <p className="text-sm text-ink-soft">Sync is part of Nekko Cloud Pro and Team. Your chats stay on this computer until then.</p>
          <button className="btn btn-primary shrink-0 py-1.5! text-xs!" onClick={() => void window.nekko.openPath(PLANS_URL)}>See plans</button>
        </div>
      )}

      {phase === 'off' && (
        <div className="sync-row">
          <p className="text-sm text-ink-soft">Turn sync on to encrypt your chats on this computer and keep a copy only your devices can open. You'll get a recovery key to save.</p>
          <button className="btn btn-primary shrink-0" disabled={!!busy} onClick={() => void turnOn()} data-testid="sync-turn-on">{busy === 'on' ? 'Setting up…' : 'Turn on sync'}</button>
        </div>
      )}

      {phase === 'needs-join' && <JoinOptions busy={!!busy} act={act} />}

      {phase === 'awaiting-approval' && (
        <div className="sync-row flex-col items-stretch!">
          <p className="text-sm text-ink-soft">On a computer or iPhone that already syncs, open <strong>Settings → Sync</strong>, choose <strong>Approve</strong> next to <strong>{status?.sync.devices.find((d) => d.thisDevice)?.label ?? 'this device'}</strong>, and type this code:</p>
          <div className="fingerprint my-3" data-testid="sync-join-code">{status?.sync.joinCode ?? '…'}</div>
          <p className="mb-3 text-center text-2xs text-ink-faint">The code proves to each device that the other is really yours. Don't share it with anyone else.</p>
          <div className="flex justify-center gap-2">
            <button className="btn btn-outline py-1! text-xs!" onClick={() => void act('now', () => window.nekko.syncNow())}>Check now</button>
            <button className="btn btn-ghost py-1! text-xs!" onClick={() => void act('restore', async () => { await window.nekko.syncSetEnabled(false); return window.nekko.cloudRefresh(); })}>Use the recovery key instead</button>
          </div>
        </div>
      )}

      {status && ['idle', 'syncing', 'paused', 'error'].includes(phase) && (
        <>
          {!status.sync.recoveryConfirmed && (
            <div className="sync-row rounded-xl bg-(--warning-soft) px-3 border-t-0!" role="status">
              <p className="text-xs text-ink">You haven't confirmed your recovery key yet. Without it, losing every device means losing your synced chats.</p>
              <button className="btn btn-outline shrink-0 py-1! text-xs!" onClick={() => setRecovery({ key: null })}>Confirm it</button>
            </div>
          )}
          <div className="sync-row">
            <div className="text-sm">
              <div className="text-ink">{syncLine(status)}</div>
              <div className="text-xs text-ink-faint">{detailLine(status)}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button className="btn btn-outline py-1! text-xs!" disabled={phase === 'syncing' || !status.sync.enabled} onClick={() => void act('now', () => window.nekko.syncNow())} data-testid="sync-now">Sync now</button>
              <Toggle label="Sync this computer" value={status.sync.enabled} onChange={(on) => void act('enable', () => window.nekko.syncSetEnabled(on))} />
            </div>
          </div>
          <div className="sync-row">
            <div className="text-sm">
              <div className="text-ink">Include Local only chats</div>
              <div className="text-xs text-ink-faint">Chats in the Local only mode stay on this computer unless you include them. Incognito chats never sync.</div>
            </div>
            <Toggle label="Include Local only chats" value={status.sync.includeLocalOnly} onChange={(on) => void act('local', () => window.nekko.syncSetIncludeLocalOnly(on))} />
          </div>
          <Devices devices={status.sync.devices} pending={pending} busy={!!busy} act={act} />
          {others === 0 && (
            <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-ink-soft">
              Add your iPhone or another computer too. A second device is the easiest way back in if this one is lost.
            </p>
          )}
          <div className="sync-row">
            <p className="text-xs text-ink-faint">Keys on this computer are kept in {status.keysStoredIn}. Key epoch {status.sync.keyEpoch ?? '–'}.</p>
            <button className="btn btn-ghost shrink-0 py-1! text-xs! text-(--danger)!" disabled={!!busy}
              onClick={() => { if (window.confirm('Delete every synced chat, key and device from Nekko Cloud? Chats on your devices stay. This can\'t be undone.')) void act('delete', () => window.nekko.syncDeleteAll()); }}>
              Delete everything synced
            </button>
          </div>
        </>
      )}

      {(error || status?.sync.error) && <p role="alert" className="mt-3 text-xs text-(--danger)">{error || status?.sync.error}</p>}
      {signIn && <CloudSignIn status={status} onClose={() => setSignIn(false)} />}
      {recovery && <RecoveryKeyDialog recoveryKey={recovery.key} email={status?.account?.email ?? ''} onDone={() => setRecovery(null)} />}
    </section>
  );
}

function JoinOptions({ busy, act }: { busy: boolean; act: (label: string, work: () => Promise<unknown>) => Promise<void> }) {
  const [key, setKey] = useState('');
  return (
    <div className="sync-row flex-col items-stretch! gap-3">
      <p className="text-sm text-ink-soft">Your account already syncs on another device. Add this computer one of two ways:</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <div className="text-sm font-medium">Use my recovery key</div>
          <textarea className="input mt-2 h-16 w-full resize-none font-mono text-xs" placeholder="XXXXX-XXXXX-…" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} aria-label="Recovery key" data-testid="sync-restore-key" />
          <button className="btn btn-primary mt-2 w-full py-1.5! text-xs!" disabled={busy || key.replace(/[\s-]/g, '').length < 55} onClick={() => void act('restore', () => window.nekko.syncRestore(key))} data-testid="sync-restore">Unlock</button>
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="text-sm font-medium">Approve from another device</div>
          <p className="mt-2 text-xs text-ink-faint">We'll show a code here. Approve this computer on a device that already syncs, after checking the code matches.</p>
          <button className="btn btn-outline mt-2 w-full py-1.5! text-xs!" disabled={busy} onClick={() => void act('join', () => window.nekko.syncRequestJoin())} data-testid="sync-request-join">Ask to join</button>
        </div>
      </div>
    </div>
  );
}

function Devices({ devices, pending, busy, act }: { devices: SyncDevice[]; pending: SyncDevice[]; busy: boolean; act: (label: string, work: () => Promise<unknown>) => Promise<void> }) {
  const live = devices.filter((d) => !d.revoked);
  if (!live.length) return null;
  return (
    <div className="sync-row flex-col items-stretch!">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Devices</div>
      {pending.length > 0 && (
        <p className="mt-2 text-xs text-ink-soft">A device is waiting to join. Approve it only if it's yours: type the code its screen shows.</p>
      )}
      <ul className="mt-2 space-y-1.5" data-testid="sync-devices">
        {live.filter((d) => d.trusted || d.thisDevice || d.askedToJoin).map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
            <div className="min-w-0">
              <div className="truncate text-sm text-ink">{d.label ?? 'Device'}{d.thisDevice && <span className="ml-2 text-2xs text-ink-faint">this computer</span>}</div>
              <div className="font-mono text-2xs tracking-wider text-ink-faint">{d.fingerprint}</div>
            </div>
            {!d.thisDevice && (d.trusted ? (
              <button className="btn btn-ghost py-0.5! text-xs!" disabled={busy}
                onClick={() => { if (window.confirm(`Remove ${d.label ?? 'this device'} from sync? It keeps what it already has but can't read anything synced from now on.`)) void act('revoke', () => window.nekko.syncRevoke(d.id)); }}>
                Remove
              </button>
            ) : (
              <ApproveWithCode device={d} busy={busy} act={act} />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Approve a device by typing the join code it shows: a mistyped code, or a key swapped by anyone else, is refused. */
function ApproveWithCode({ device, busy, act }: { device: SyncDevice; busy: boolean; act: (label: string, work: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const clean = code.replace(/[^0-9a-z]/gi, '');
  if (!open) {
    return (
      <button className="btn btn-primary py-0.5! text-xs!" disabled={busy} data-testid="sync-approve" onClick={() => setOpen(true)}>
        Approve
      </button>
    );
  }
  return (
    <form className="flex w-full items-center gap-2" data-testid="sync-approve-form"
      onSubmit={(e) => { e.preventDefault(); void act('approve', () => window.nekko.syncApprove(device.id, code)); }}>
      <input className="input min-w-0 flex-1 font-mono tracking-wider uppercase" autoFocus spellCheck={false} autoComplete="off"
        aria-label={`Join code shown on ${device.label ?? 'the new device'}`} placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={24}
        value={code} onChange={(e) => setCode(e.target.value)} data-testid="sync-approve-code" />
      <button type="submit" className="btn btn-primary py-1! text-xs!" disabled={busy || clean.length !== 16}>Approve</button>
      <button type="button" className="btn btn-ghost py-1! text-xs!" onClick={() => { setOpen(false); setCode(''); }}>Cancel</button>
    </form>
  );
}

function PhasePill({ status }: { status: CloudStatus | null }) {
  const phase = status?.sync.phase ?? 'signed-out';
  const [cls, text] = ({
    'signed-out': ['off', 'Signed out'],
    'needs-plan': ['off', 'Not included'],
    off: ['off', 'Off'],
    'needs-join': ['warn', 'Add this computer'],
    'awaiting-approval': ['warn', 'Waiting for approval'],
    syncing: ['busy', status?.sync.progress ? `Syncing ${status.sync.progress.done}/${status.sync.progress.total}` : 'Syncing'],
    idle: ['ok', 'Up to date'],
    paused: ['off', 'Paused'],
    error: ['bad', 'Needs attention'],
  } as const)[phase];
  return <span className={`sync-pill ${cls}`} data-testid="sync-phase">{text}</span>;
}

function planLabel(plan?: string) {
  return plan === 'team' ? 'Nekko Cloud Team' : plan === 'pro' ? 'Nekko Cloud Pro' : 'Free plan';
}

function syncLine(s: CloudStatus) {
  if (s.sync.phase === 'syncing') return 'Syncing…';
  if (s.sync.phase === 'paused') return 'Sync is paused on this computer';
  if (!s.sync.lastSyncAt) return 'Not synced yet';
  return `Synced ${ago(s.sync.lastSyncAt)}`;
}

function detailLine(s: CloudStatus) {
  const parts = [`${s.sync.chats} chat${s.sync.chats === 1 ? '' : 's'}`];
  if (s.sync.usage) parts.push(`${bytes(s.sync.usage.bytes)} of ${bytes(s.sync.usage.limit)} encrypted storage`);
  const tooLarge = s.sync.skipped.tooLarge ?? 0;
  if (tooLarge) parts.push(`${tooLarge} too large to sync`);
  return parts.join(' · ');
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ms).toLocaleDateString();
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
