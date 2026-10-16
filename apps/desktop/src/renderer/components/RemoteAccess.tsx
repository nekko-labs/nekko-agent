import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { relayUrlProblem, type LocalRelayStatus, type PairingGrant, type RemoteDevice, type RemoteStatus } from '@nekko-agent/shared';
import { Badge } from './primitives/index.js';

/**
 * Settings card for phone remote control: expose this machine over a relay,
 * pair devices with short-lived one-time codes, and manage (rename / revoke)
 * everything that's paired. Traffic is end-to-end encrypted; the relay only
 * sees ciphertext. Self-hosting the relay is documented and first-class.
 */

/** Managed relay (free during beta; becomes a Nekko Agent Cloud perk). */
export const MANAGED_RELAY_URL = 'wss://nekko-agent-relay.fly.dev';
const SELF_HOST_DOCS = 'https://github.com/nekko-labs/nekko-agent/blob/main/docs/REMOTE.md';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

export function RemoteAccess() {
  const [status, setStatus] = useState<RemoteStatus>({ enabled: false });
  const [relayUrl, setRelayUrl] = useState(MANAGED_RELAY_URL);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<PairingGrant | null>(null);
  const [now, setNow] = useState(Date.now());
  const [qr, setQr] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [link, setLink] = useState('');
  const [urlProblem, setUrlProblem] = useState<string | undefined>();
  const editedUrl = useRef(false);

  const refresh = async () => {
    const s = await window.nekko.getRemoteStatus();
    setStatus(s);
    if (s.relayUrl && !editedUrl.current) setRelayUrl(s.relayUrl);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Live view while enabled: connected devices + pairing-code countdown.
  useEffect(() => {
    if (!status.enabled) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [status.enabled]);
  useEffect(() => {
    if (!grant) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [grant]);

  const liveGrant = grant && grant.expiresAt > now ? grant : null;

  // Pairing link: on an http origin (web edition) the link opens this same UI;
  // the desktop app has no web origin, so the QR carries the raw pairing params
  // (the Nekko Agent phone app parses those directly).
  useEffect(() => {
    if (!status.enabled || !liveGrant) {
      setLink('');
      return;
    }
    void window.nekko.getRemotePairing().then((p) => {
      if (!p) return setLink('');
      setLink(`${location.protocol.startsWith('http') ? location.origin + '/' : 'nekko-agent-pair:'}?relay=${encodeURIComponent(
        p.relayUrl,
      )}&room=${p.room}&key=${p.key}&pair=${liveGrant.code}`);
    });
  }, [status.enabled, liveGrant?.code]);

  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''));
    else setQr('');
  }, [link]);

  const enable = async () => {
    if (!relayUrl.trim()) return;
    // The phone refuses plain ws:// to the open internet; refuse it here first.
    const problem = relayUrlProblem(relayUrl);
    setUrlProblem(problem);
    if (problem) return;
    setBusy(true);
    try {
      setStatus(await window.nekko.enableRemote(relayUrl.trim()));
    } catch (e) {
      // The computer applies the same rule (and any other refusal) and says why.
      setUrlProblem(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    setGrant(null);
    setStatus(await window.nekko.disableRemote());
    setBusy(false);
  };
  const pair = async () => {
    setGrant(await window.nekko.startRemotePairing());
    setNow(Date.now());
  };
  const revoke = async (d: RemoteDevice) => {
    if (!confirm(`Revoke "${d.name}"? It loses access immediately and must be paired again.`)) return;
    await window.nekko.revokeRemoteDevice(d.id);
    void refresh();
  };
  const rotate = async () => {
    if (!confirm('Rotate the pairing secret? Every paired device is removed and must pair again with a fresh QR.')) return;
    setGrant(null);
    setStatus(await window.nekko.rotateRemoteSecret());
  };
  const saveRename = async (id: string) => {
    if (renameText.trim()) await window.nekko.renameRemoteDevice(id, renameText.trim());
    setRenaming(null);
    void refresh();
  };

  const devices = status.devices ?? [];
  const active = devices.filter((d) => !d.revoked);
  const connected = new Set(status.connected ?? []);
  const secsLeft = liveGrant ? Math.max(0, Math.ceil((liveGrant.expiresAt - now) / 1000)) : 0;

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2">
        <span className="text-base">📱</span>
        <h2 className="font-semibold">Remote access</h2>
        {status.enabled && (
          <Badge tone={status.online ? 'success' : 'warning'} variant="solid">
            {status.online ? 'online' : status.error ? 'relay error' : 'connecting…'}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Run and manage your chats, training runs, and goals from your phone. Your device pairs to this
        machine over an end-to-end encrypted relay (the relay only sees ciphertext); inference and tools
        keep running here, under this machine's guardrails.
      </p>
      {status.error && !status.online && (
        <p className="mt-2 rounded border border-line px-2 py-1.5 text-[12px] text-ink-soft">{status.error}</p>
      )}

      {!status.enabled ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              className="input py-1.5 text-[13px]"
              placeholder={`Relay URL, e.g. ${MANAGED_RELAY_URL}`}
              value={relayUrl}
              onChange={(e) => {
                editedUrl.current = true;
                setUrlProblem(undefined);
                setRelayUrl(e.target.value);
              }}
            />
            <button className="btn btn-primary py-1.5" onClick={enable} disabled={busy}>
              {busy ? 'Connecting…' : 'Enable'}
            </button>
          </div>
          {urlProblem && (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
              {urlProblem}
            </p>
          )}
          <p className="text-[11.5px] text-ink-faint">
            The default is the managed Nekko Agent relay (free during beta). Privacy purists can{' '}
            <a className="underline" href={SELF_HOST_DOCS} target="_blank" rel="noreferrer">
              self-host the relay
            </a>{' '}
            with one Docker command and paste its URL here.
          </p>
          <LocalRelayCard
            onUse={(url) => {
              editedUrl.current = true;
              setUrlProblem(undefined);
              setRelayUrl(url);
            }}
          />
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="grid grid-cols-1 gap-1 text-[12.5px] sm:grid-cols-2">
            <Field label="Relay" value={status.relayUrl!} />
            <Field label="Room" value={status.room!} mono />
          </div>
          <LocalRelayCard inUse={status.relayUrl} />

          {/* Paired devices */}
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-medium">Paired devices</h3>
              <button className="btn btn-primary py-1 text-[12px]" onClick={pair}>
                + Pair a device
              </button>
            </div>
            {active.length === 0 ? (
              <p className="mt-2 text-[12px] text-ink-faint">
                Nothing paired yet. Hit “Pair a device” and scan the QR from your phone.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {active
                  .slice()
                  .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                  .map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                      <span aria-hidden>{platformIcon(d.platform)}</span>
                      {renaming === d.id ? (
                        <input
                          className="input max-w-[180px] py-0.5 text-[12.5px]"
                          value={renameText}
                          autoFocus
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && saveRename(d.id)}
                          onBlur={() => saveRename(d.id)}
                        />
                      ) : (
                        <button className="font-medium hover:underline" title="Rename" onClick={() => {
                          setRenaming(d.id);
                          setRenameText(d.name);
                        }}>
                          {d.name}
                        </button>
                      )}
                      <span
                        className="h-2 w-2 rounded-full"
                        title={connected.has(d.id) ? 'Connected now' : 'Offline'}
                        style={{ background: connected.has(d.id) ? 'var(--success)' : 'var(--line)' }}
                      />
                      <span className="ml-auto text-ink-faint">{connected.has(d.id) ? 'connected' : `seen ${ago(d.lastSeenAt, now)}`}</span>
                      <button className="btn btn-ghost py-0.5 text-[12px]" style={{ color: 'var(--danger)' }} onClick={() => revoke(d)}>
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          {/* Pairing QR (short-lived, single-use) */}
          {liveGrant && link && (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-3 sm:flex-row sm:items-center">
              {qr && <img src={qr} alt="Pairing QR" width={132} height={132} className="rounded-lg border border-line" />}
              <div className="min-w-0">
                <div className="text-[12px]">
                  Scan from the Nekko Agent app (or open the link in your phone's browser). One device,{' '}
                  <span className="font-mono font-medium">{Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}</span>{' '}
                  left.
                </div>
                <code className="mt-1 block break-all rounded-lg px-2 py-1.5 font-mono text-[11px]" style={{ background: 'var(--surface-2)' }}>
                  {link}
                </code>
                <button className="btn btn-outline mt-2 py-1 text-[12px]" onClick={() => navigator.clipboard?.writeText(link)}>
                  Copy link
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost py-1.5 text-[12px]" onClick={disable} disabled={busy}>
              Disable remote access
            </button>
            <button className="btn btn-ghost py-1.5 text-[12px]" title="New secret; all devices must re-pair" onClick={rotate}>
              Rotate secret…
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Relay on this computer: the app runs the relay itself on this computer's
 * Tailscale address, so phones on the same tailnet need no hosted relay.
 * `onUse` fills the relay field (before remote access is on); `inUse` is the
 * relay remote access is using (after), to say whether it is this one.
 */
export function LocalRelayCard({ onUse, inUse }: { onUse?: (url: string) => void; inUse?: string }) {
  const [relay, setRelay] = useState<LocalRelayStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => void window.nekko.localRelayStatus?.().then((s) => live && setRelay(s)).catch(() => {});
    load();
    // Tailscale coming up, or the relay starting on its own, shows without a click.
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!relay || relay.available === false) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      const next = relay.enabled ? await window.nekko.localRelayStop() : await window.nekko.localRelayStart();
      setRelay(next);
      if (!relay.enabled && next.running && next.url) onUse?.(next.url);
    } finally {
      setBusy(false);
    }
  };
  return <LocalRelayView relay={relay} busy={busy} onToggle={toggle} onUse={onUse} inUse={inUse} />;
}

export function LocalRelayView({
  relay,
  busy,
  onToggle,
  onUse,
  inUse,
}: {
  relay: LocalRelayStatus;
  busy?: boolean;
  onToggle: () => void;
  onUse?: (url: string) => void;
  inUse?: string;
}) {
  const usedHere = !!inUse && !!relay.url && inUse === relay.url;
  const where = relay.tailnetName ?? relay.tailnetIp;

  return (
    <div data-shot="local-relay" className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-medium">Relay on this computer</h3>
        <Badge tone={relay.running ? 'success' : relay.tailnetIp ? 'neutral' : 'warning'} variant="soft">
          {relay.running ? 'running' : relay.enabled ? 'waiting' : 'Tailscale'}
        </Badge>
        <button className={`btn ${relay.enabled ? 'btn-ghost' : 'btn-outline'} ml-auto py-1 text-[12px]`} onClick={onToggle} disabled={busy}>
          {busy ? (relay.enabled ? 'Stopping…' : 'Starting…') : relay.enabled ? 'Stop' : 'Start relay'}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Phones on your Tailscale network connect straight to this computer over WireGuard, with no hosted relay in
        between. Listens on the tailnet address only.
      </p>
      {relay.tailnetIp ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--success)' }} aria-hidden />
          <span className="text-ink-soft">
            Tailscale connected: <span className="font-mono">{where}</span>
          </span>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-ink-soft">
          Tailscale isn’t connected on this computer.{' '}
          <a className="underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            Get Tailscale
          </a>
          , sign in on this computer and your phone, and {relay.enabled ? 'the relay starts by itself.' : 'start the relay.'}
        </p>
      )}
      {relay.running && relay.url && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="rounded px-2 py-1 font-mono text-[11.5px]" style={{ background: 'var(--surface-2)' }}>
            {relay.url}
          </code>
          {onUse ? (
            <button className="btn btn-primary py-1 text-[12px]" onClick={() => onUse(relay.url!)}>
              Use this relay
            </button>
          ) : usedHere ? (
            <span className="text-[12px] text-ink-faint">Remote access is using this relay.</span>
          ) : null}
        </div>
      )}
      {relay.error && relay.tailnetIp && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>
          {relay.error}
        </p>
      )}
    </div>
  );
}

function platformIcon(platform: string): string {
  switch (platform) {
    case 'ios':
      return '📱';
    case 'android':
      return '🤖';
    case 'web':
      return '🌐';
    default:
      return '💻';
  }
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (s < 3600) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(s / 3600);
  if (s < 86400) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink-faint">{label}:</span>
      <span className={`truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
