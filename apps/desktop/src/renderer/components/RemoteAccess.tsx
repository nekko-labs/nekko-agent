import React, { useEffect, useRef, useState } from 'react';
import { CLOUD_RELAY_URL, pairingLink, relayRoute, phoneDeviceAccess, PHONE_KEY_CHANNEL, PROTECT_COMPUTER_DOCS_URL, relayHost, relayUrlProblem, relayVia, remoteStoppedBanner, type CloudStatus, type DeviceRoute, type SecurityStatus, type LocalRelayStatus, type NetworkVisibilityStatus, type PairingGrant, type PhoneActivityEntry, type RemoteDevice, type RemoteStatus } from '@nekko-agent/shared';
import { StatusDot } from './primitives/index.js';
import { Toggle } from './primitives/Toggle.js';
import { useStore } from '../store.js';
import { RouterIcon, LogOutIcon } from '../gentleface-icons.js';
import { CheckIcon, ComputerIcon, GlobeIcon, PhoneIcon } from '../icons.js';
import { SECURITY_SECTION_ID } from './security/SecuritySettings.js';
import { SettingRow, SettingsSection } from './SettingsSection.js';

/**
 * Settings card for phone remote control: expose this machine over a relay,
 * pair devices with short-lived one-time codes, and manage (rename / revoke)
 * everything that's paired. Traffic is end-to-end encrypted; the relay only
 * sees ciphertext. Self-hosting the relay is documented and first-class.
 */

/** The managed relay, shown to owners as Nekko Cloud Relay (decision 0116). */
export const MANAGED_RELAY_URL = CLOUD_RELAY_URL;
/**
 * Whether the managed relay is deployed. It is not today (the Fly app is gone
 * and its name no longer resolves), so Nekko Cloud is shown as coming soon and
 * a computer still pointed at it is told to change. Flip this when it is back.
 */
export const NEKKO_CLOUD_LIVE = false;
/**
 * What this account is offered of Nekko Cloud Relay (decision 0116), a Pro
 * perk: `hidden` until the `cloud-relay` switch shows it to the account (so
 * signed-out and not-yet-launched accounts see *Coming soon*), `upgrade` on
 * Free, `included` on Pro, Team, or a Nekko team account.
 */
export type CloudRelayOffer = 'hidden' | 'upgrade' | 'included';
export function cloudRelayOffer(cloud: CloudStatus | null | undefined): CloudRelayOffer {
  const a = cloud?.signedIn ? cloud.account : null;
  if (!a?.features?.cloudRelay) return 'hidden';
  return a.plan === 'pro' || a.plan === 'team' || a.staff ? 'included' : 'upgrade';
}

/** What the owner calls a route. */
export const ROUTE_LABEL: Record<DeviceRoute, string> = { auto: 'Either', cloud: 'Nekko Cloud Relay', direct: 'Tailscale' };

/** The ways in, as the owner ticks them: Tailscale and/or Nekko Cloud Relay. */
export interface RoutePicks {
  tailscale: boolean;
  cloud: boolean;
}

/** A device's route as ticks, and back: both is `auto`, one is that one. */
export function picksOf(route: DeviceRoute | undefined): RoutePicks {
  return { tailscale: route !== 'cloud', cloud: route !== 'direct' };
}
export function routeOf(p: RoutePicks): DeviceRoute {
  return p.tailscale && p.cloud ? 'auto' : p.cloud ? 'cloud' : 'direct';
}

/**
 * The relays that make `picks` true (decision 0116): Tailscale is the main
 * relay when it is ticked (nearest), else Nekko Cloud Relay; the other is the
 * extra one. Any relay besides these two is kept. Swapping the main relay
 * keeps the room, so a phone still has whichever route it shares with the new set.
 */
export function routeTargets(picks: RoutePicks, tailnetUrl: string | undefined, also: string[] = []): { main: string; also: string[] } | null {
  if (picks.tailscale && !tailnetUrl) return null;
  const main = picks.tailscale ? tailnetUrl! : CLOUD_RELAY_URL;
  const others = also.filter((u) => u !== tailnetUrl && relayVia(u) !== 'cloud');
  return { main, also: [...(picks.tailscale && picks.cloud ? [CLOUD_RELAY_URL] : []), ...others] };
}

/** What is ticked now: the main relay and the extra ones, by kind. Your own relay counts as neither. */
export function currentPicks(status: RemoteStatus, local: LocalRelayStatus | null): RoutePicks {
  const urls = status.enabled ? [status.relayUrl, ...(status.alsoRelays ?? [])].filter(Boolean) as string[] : [];
  const tailnet = (u: string) => connectionName(u, local) === 'Tailscale' || relayRoute(u) === 'tailscale';
  return { tailscale: urls.some(tailnet), cloud: urls.some((u) => relayVia(u) === 'cloud') };
}

/**
 * Where a pairing link sends a device (decision 0116): for `auto`, every route
 * this computer has, nearest first (the main relay, its LAN addresses, then
 * Nekko Cloud Relay as the fallback); for `cloud` or `direct`, only that kind.
 * The computer checks the route again at HELLO, so this only spares the phone
 * dialing a route it would be turned away on.
 */
export function pairingRoutes(main: string, also: string[], lanAlts: string[], route: DeviceRoute): { relayUrl: string; alts: string[] } {
  const all = [main, ...lanAlts, ...also].filter((u, i, a) => a.indexOf(u) === i);
  const allowed = all.filter((u) => route === 'auto' || relayVia(u) === route);
  const ordered = [...allowed.filter((u) => relayVia(u) === 'direct'), ...allowed.filter((u) => relayVia(u) === 'cloud')];
  return { relayUrl: ordered[0] ?? main, alts: ordered.slice(1) };
}

const SELF_HOST_DOCS = 'https://github.com/nekko-labs/nekko-agent/blob/main/docs/REMOTE.md';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

/**
 * The address Enable connects to. When it is the default relay on this
 * computer and that relay isn't running, start it first and use the address
 * it ended up on; if it can't start, say why instead of enabling.
 */
export async function relayToEnable(
  url: string,
  fallback: { url: string; local: boolean },
  local: LocalRelayStatus | null,
  start: () => Promise<LocalRelayStatus>,
): Promise<{ url?: string; started?: LocalRelayStatus; problem?: string }> {
  if (!fallback.local || url !== fallback.url || local?.running) return { url };
  const started = await start();
  if (!started.running || !started.url) return { started, problem: started.error ?? 'The relay on this computer did not start.' };
  return { url: started.url, started };
}

/**
 * Where a pairing link points. An http origin (Local Web UI) opens this same UI on
 * the phone, unless it is loopback (the desktop app under Vite in dev, or the web UI
 * opened on this computer): on the phone that is the phone itself, so the link uses
 * the app's own scheme instead.
 */
export function pairingBase(loc: { protocol: string; hostname: string; origin: string }): string {
  const loopback = /^(localhost|127\.|\[::1\]$)/.test(loc.hostname);
  return loc.protocol.startsWith('http') && !loopback ? loc.origin + '/' : 'nekko-agent-pair:';
}

/**
 * The extra routes a pairing link carries (TASKS.md IO-20): when remote access
 * uses the relay on this computer (by MagicDNS name or tailnet address, same
 * port) and that relay also listens on the LAN, its LAN addresses. A phone on
 * the same Wi-Fi then skips the tailnet. Any other relay: none.
 */
export function pairingAlts(relayUrl: string, local: LocalRelayStatus | null): string[] {
  if (!local?.running || !local.lanUrls?.length) return [];
  const port = (u: string) => u.trim().match(/^wss?:\/\/(?:\[[^\]]*\]|[^/:?#]*)(?::(\d+))?/i)?.[1] ?? '';
  const here = [local.tailnetName, local.tailnetIp].filter(Boolean).map((h) => h!.toLowerCase());
  if (!/^ws:\/\//i.test(relayUrl.trim()) || !here.includes(relayHost(relayUrl)) || port(relayUrl) !== String(local.port)) return [];
  return local.lanUrls;
}

/**
 * How big the pairing QR is drawn, in CSS pixels. The link carries the relay,
 * room, key, host key, code and LAN routes (about 230-300 characters, a version
 * 9-12 code), so at the old 132 px each module was about 2 px, under half a
 * millimetre on a laptop screen: phones had to come so close that their main
 * camera could no longer focus. At this size a module is about 4 px.
 */
export const PAIRING_QR_SIZE = 232;

/**
 * The pairing QR as an SVG data URL: sharp at any zoom or display scale (the
 * old PNG was scaled from 220 px down to 132, blurring module edges). Low error
 * correction, because a screen is never smudged or torn, gives fewer, larger
 * modules; the two-module margin keeps a white quiet zone in the dark theme.
 */
export async function pairingQr(link: string): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'L', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function RemoteAccess() {
  const [status, setStatus] = useState<RemoteStatus>({ enabled: false });
  const [relayUrl, setRelayUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<PairingGrant | null>(null);
  const [now, setNow] = useState(Date.now());
  const [qr, setQr] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [link, setLink] = useState('');
  const [urlProblem, setUrlProblem] = useState<string | undefined>();
  const [localRelay, setLocalRelay] = useState<LocalRelayStatus | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  /** The route the next pairing code is for (decision 0116). */
  const [pairRoute, setPairRoute] = useState<DeviceRoute>('auto');
  const offer = cloudRelayOffer(cloud);
  const cloudAvail = cloudAvailability(offer);
  /** The ticks before remote access is on; nothing until the owner picks, then defaults fill in. */
  const [draftPick, setDraft] = useState<RoutePicks | null>(null);
  const draft = draftPick ?? { tailscale: !!localRelay?.tailnetIp, cloud: cloudAvail === 'live' };

  // Whether Nekko Cloud Relay is offered to this account, and on its plan.
  useEffect(() => {
    void window.nekko.cloudStatus?.().then(setCloud).catch(() => {});
  }, [status.enabled]);

  // Whether step-up is on, for the one-time *Protect this computer* prompt (SK-10).
  useEffect(() => {
    void window.nekko.securityStatus?.().then(setSecurity).catch(() => {});
  }, [status.enabled]);

  const refresh = async () => {
    setStatus(await window.nekko.getRemoteStatus());
  };

  // This computer's relay status, for the Tailscale option and the connection label.
  useEffect(() => {
    let live = true;
    const load = () => void window.nekko.localRelayStatus?.().then((r) => live && setLocalRelay(r)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

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

  // Pairing link: on an http origin (Local Web UI) the link opens this same UI;
  // the desktop app has no web origin, so the QR carries the raw pairing params
  // (the Nekko Agent phone app parses those directly). The relay on this
  // computer's LAN addresses ride along as `alt` routes.
  const alts = pairingAlts(status.relayUrl ?? '', localRelay).join(' ');
  useEffect(() => {
    if (!status.enabled || !liveGrant) {
      setLink('');
      return;
    }
    void window.nekko.getRemotePairing().then((p) => {
      if (!p) return setLink('');
      const routes = pairingRoutes(p.relayUrl, status.alsoRelays ?? [], pairingAlts(p.relayUrl, localRelay), pairRoute);
      setLink(pairingLink(pairingBase(location), { ...p, ...routes, pair: liveGrant.code }));
    });
  }, [status.enabled, liveGrant?.code, alts, pairRoute, (status.alsoRelays ?? []).join(' ')]);

  useEffect(() => {
    if (link) pairingQr(link).then(setQr).catch(() => setQr(''));
    else setQr('');
  }, [link]);

  /** Turn remote access on through `url`; `local` starts this computer's relay first (Tailscale). */
  const enable = async (url: string, local = false) => {
    if (!url.trim()) return;
    // The phone refuses plain ws:// to the open internet; refuse it here first.
    const problem = local ? undefined : relayUrlProblem(url);
    setUrlProblem(problem);
    if (problem) return;
    setBusy(true);
    try {
      const target = await relayToEnable(url.trim(), { url: url.trim(), local }, localRelay, () => window.nekko.localRelayStart());
      if (target.started) setLocalRelay(target.started);
      if (!target.url) return setUrlProblem(target.problem);
      setStatus(await window.nekko.enableRemote(target.url));
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
  /** Back to the Tailscale / Nekko Cloud choice. Phones carry the old address, so they pair again. */
  const change = async () => {
    if (active.length > 0 && !confirm('Change how phones connect? Paired phones keep the old address and need to pair again afterwards.')) return;
    await disable();
  };
  const pair = async (route: DeviceRoute = pairRoute) => {
    setPairRoute(route);
    setGrant(await window.nekko.startRemotePairing(route));
    setNow(Date.now());
  };
  /**
   * Make the ticked ways in true (decision 0116): start this computer's relay
   * for Tailscale, make the nearest ticked route the main one, and hold the
   * room on the other too. Turns remote access on when it is off.
   */
  const applyPicks = async (next: RoutePicks) => {
    if (!next.tailscale && !next.cloud) return;
    const now = currentPicks(status, localRelay);
    const dropped = [now.tailscale && !next.tailscale && 'Tailscale', now.cloud && !next.cloud && 'Nekko Cloud Relay'].filter(Boolean);
    if (dropped.length && active.length > 0 && !confirm(`Stop connecting through ${dropped.join(' and ')}? A phone paired only that way can’t reach this computer until it pairs again.`)) return;
    setUrlProblem(undefined);
    setBusy(true);
    try {
      let tailnetUrl = localRelay?.url;
      if (next.tailscale && tailnetUrl) {
        const t = await relayToEnable(tailnetUrl, { url: tailnetUrl, local: true }, localRelay, () => window.nekko.localRelayStart());
        if (t.started) setLocalRelay(t.started);
        if (!t.url) return setUrlProblem(t.problem);
        tailnetUrl = t.url;
      }
      const target = routeTargets(next, tailnetUrl, status.alsoRelays ?? []);
      if (!target) return setUrlProblem('Tailscale isn’t connected on this computer.');
      let s = status;
      if (!s.enabled || s.relayUrl !== target.main) s = await window.nekko.enableRemote(target.main);
      const have = (s.alsoRelays ?? []).join(' ');
      if (have !== target.also.join(' ')) s = (await window.nekko.setRemoteRelays?.(target.also)) ?? s;
      setStatus(s);
    } catch (e) {
      setUrlProblem(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };
  const setRoute = async (d: RemoteDevice, route: DeviceRoute) => {
    await window.nekko.setRemoteRoute?.(d.id, route);
    void refresh();
  };
  const upgrade = async () => {
    const { url } = await window.nekko.cloudBillingCheckout('pro');
    window.open(url, '_blank', 'noopener');
  };
  const revoke = async (d: RemoteDevice) => {
    if (!confirm(`Revoke "${d.name}"? It loses access immediately and must be paired again.`)) return;
    await window.nekko.revokeRemoteDevice(d.id);
    void refresh();
  };
  const rotate = async () => {
    if (!confirm('Sign out all phones? The room is re-keyed: every paired device is removed and must pair again with a fresh QR.')) return;
    setGrant(null);
    setStatus(await window.nekko.rotateRemoteSecret());
  };
  const saveRename = async (id: string) => {
    if (renameText.trim()) await window.nekko.renameRemoteDevice(id, renameText.trim());
    setRenaming(null);
    void refresh();
  };

  const devices = status.devices ?? [];
  /** Both kinds of route are up (or configured): pairing and devices may pick one. */
  const routes = new Set([status.relayUrl, ...(status.alsoRelays ?? [])].filter(Boolean).map((u) => relayVia(u!)));
  const twoRoutes = routes.size > 1;
  const picks = currentPicks(status, localRelay);
  /** Remote access runs through a relay of the owner's own: neither Tailscale here nor Nekko Cloud Relay. */
  const ownRelay = status.enabled && !!status.relayUrl && !picks.tailscale && relayVia(status.relayUrl) !== 'cloud';
  /** Whether the route of that kind is up, from the engine's per-relay status (the main relay's own when it has none). */
  const routeLive = (via: 'direct' | 'cloud'): RouteLive | undefined => {
    const r = status.relays?.find((x) => x.via === via);
    if (r) return { online: r.online, error: r.error };
    return status.relayUrl && relayVia(status.relayUrl) === via ? { online: !!status.online, error: status.error } : undefined;
  };
  // What would be ticked before remote access is on: only what can work now.
  const draftUsable = { tailscale: draft.tailscale && !!localRelay?.tailnetIp && !!localRelay.url, cloud: draft.cloud && cloudAvail === 'live' };
  const active = devices.filter((d) => !d.revoked);
  const connected = new Set(status.connected ?? []);
  const secsLeft = liveGrant ? Math.max(0, Math.ceil((liveGrant.expiresAt - now) / 1000)) : 0;

  return (
    <SettingsSection
      title="Remote access"
      meta={status.enabled && (
        <span className={`inline-flex items-center gap-1.5 ${status.online ? '' : 'text-warning-text'}`}>
          <StatusDot tone={status.online ? 'success' : 'warning'} size={7} />
          {status.online ? 'online' : status.error ? 'relay error' : 'connecting…'}
        </span>
      )}
      help={<>
        Run and manage your chats, training runs, and goals from your phone. Everything is end-to-end encrypted;
        inference and tools keep running here, under this machine's guardrails.{!status.enabled && ' Pick how your phone connects:'}
      </>}
    >
      <ComputerName />
      {!status.enabled && status.stoppedBy && <RemoteStoppedBanner stoppedBy={status.stoppedBy} />}
      {status.error && !status.online && (
        <p className="mt-(--q-inline) text-xs text-danger-text">{status.error}</p>
      )}

      {!status.enabled ? (
        <div className="mt-(--q-group)">
          <ConnectThroughView
            local={localRelay}
            picks={draft}
            cloud={cloudAvail}
            busy={busy}
            onChange={setDraft}
            onUpgrade={() => void upgrade()}
          />
          <button className="btn btn-primary mt-(--q-inline) py-1 text-xs disabled:opacity-50" onClick={() => void applyPicks(draftUsable)} disabled={busy || (!draftUsable.tailscale && !draftUsable.cloud)}>
            {busy ? 'Connecting…' : 'Turn on remote access'}
          </button>
          {urlProblem && <p className="mt-(--q-inline) text-xs text-danger-text">{urlProblem}</p>}
          <OwnRelay
            relayUrl={relayUrl}
            busy={busy}
            onRelayUrl={(url) => {
              setUrlProblem(undefined);
              setRelayUrl(url);
            }}
            onConnect={() => void enable(relayUrl)}
          />
        </div>
      ) : (
        <div className="mt-(--q-group) space-y-(--q-group)">
          {security && !security.enabled && <ProtectComputerPrompt />}
          {!NEKKO_CLOUD_LIVE && offer === 'hidden' && status.relayUrl === MANAGED_RELAY_URL && <CloudGoneBanner busy={busy} onChange={() => void change()} />}
          {ownRelay ? (
            <div className="flex items-end gap-2 text-xs">
              <Field label="Connected through" value={status.relayUrl!} />
              <button className="btn btn-ghost py-1 text-xs" onClick={() => void change()} disabled={busy}>
                Change
              </button>
            </div>
          ) : (
            <div>
              <ConnectThroughView
                local={localRelay}
                picks={picks}
                cloud={cloudAvail}
                busy={busy}
                live={{ tailscale: routeLive('direct'), cloud: routeLive('cloud') }}
                onChange={(p) => void applyPicks(p)}
                onUpgrade={() => void upgrade()}
              />
              {urlProblem && <p className="mt-(--q-inline) text-xs text-danger-text">{urlProblem}</p>}
            </div>
          )}
          {/* Paired devices */}
          <div data-shot="phone-pairing">
            <div className="flex items-center justify-between">
              <h3 className="quiet-group-label">Paired devices</h3>
              <button className="btn btn-primary py-1 text-xs" onClick={() => void pair()}>
                + Pair a device
              </button>
            </div>
            {twoRoutes && (
              <DeviceRoutePicks
                label="The next device connects through"
                caption="The next device connects through"
                value={pairRoute}
                onChange={(r) => void pair(r)}
              />
            )}
            {/* Pairing QR (short-lived, single-use) */}
            {liveGrant && link && (
              <div className="mt-(--q-inline) flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                {qr && (
                  <img
                    src={qr}
                    alt="Pairing QR"
                    width={PAIRING_QR_SIZE}
                    height={PAIRING_QR_SIZE}
                    className="shrink-0 rounded-lg"
                  />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium">Scan with your phone's camera to connect.</div>
                  <div
                    className="mt-(--q-inline) inline-flex items-baseline gap-2"
                    aria-label={`Code expires in ${Math.floor(secsLeft / 60)} minutes ${secsLeft % 60} seconds`}
                  >
                    <span className="text-2xs text-ink-faint">Expires in</span>
                    <span className={`font-mono text-xl font-semibold tabular-nums ${secsLeft < 60 ? 'text-warning-text' : ''}`}>
                      {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}
                    </span>
                  </div>
                  <details className="mt-(--q-tight)">
                    <summary className="w-fit cursor-pointer text-xs text-ink-faint transition-colors duration-(--dur-fast) hover:text-ink">Can’t scan? Show the link</summary>
                    <code className="mt-(--q-tight) block break-all rounded-lg px-2 py-1 font-mono text-2xs" style={{ background: 'var(--surface-2)' }}>
                      {link}
                    </code>
                    <button className="btn btn-ghost mt-(--q-inline) py-1 text-xs" onClick={() => navigator.clipboard?.writeText(link)}>
                      Copy link
                    </button>
                  </details>
                </div>
              </div>
            )}
            {active.length === 0 ? (
              <p className="mt-(--q-inline) text-xs text-ink-faint">
                Nothing paired yet. Hit “Pair a device” and scan the QR from your phone.
              </p>
            ) : (
              <ul className="-mx-2 mt-(--q-inline)">
                {active
                  .slice()
                  .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                  .map((d) => (
                    <li key={d.id} className="quiet-row min-h-(--q-row) flex-wrap gap-2 px-2! text-xs" data-quiet-row>
                      <span aria-hidden className="flex text-ink-soft">{platformIcon(d.platform)}</span>
                      {renaming === d.id ? (
                        <input
                          className="quiet-field max-w-[180px] py-1 text-xs"
                          value={renameText}
                          autoFocus
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && saveRename(d.id)}
                          onBlur={() => saveRename(d.id)}
                        />
                      ) : (
                        <button className="text-sm font-medium hover:underline" title="Rename" onClick={() => {
                          setRenaming(d.id);
                          setRenameText(d.name);
                        }}>
                          {d.name}
                        </button>
                      )}
                      <StatusDot tone={connected.has(d.id) ? 'success' : 'neutral'} title={connected.has(d.id) ? 'Connected now' : 'Offline'} />
                      <span className="ml-auto text-ink-faint">{connected.has(d.id) ? 'connected' : `seen ${ago(d.lastSeenAt, now)}`}</span>
                      {(twoRoutes || d.route) && (
                        <DeviceRoutePicks
                          label={`How ${d.name} connects`}
                          value={d.route ?? 'auto'}
                          onChange={(r) => void setRoute(d, r)}
                        />
                      )}
                      <button className="btn btn-ghost quiet-row-action py-1 text-xs" onClick={() => void pair(d.route ?? 'auto')} aria-label={`Re-pair ${d.name}`}>Re-pair</button>
                      <button className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" onClick={() => revoke(d)}>
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          <div className="text-xs">
            <Field label="Room" value={status.room!} mono />
          </div>
          {picks.tailscale && <LocalRelayCard inUse={status.relayUrl} onStatus={setLocalRelay} />}
          <NetworkVisibilitySwitch />
          <PhoneChangesSwitch />
          <PhoneAccess devices={active} onChanged={() => void refresh()} />
          <LockPhonesSwitch devices={active} onChanged={() => void refresh()} />
          <QuitFromPhoneSwitch />

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost py-1 text-xs" onClick={disable} disabled={busy}>
              Disable remote access
            </button>
            <button className="btn btn-ghost py-1 text-xs text-danger-text" title="Re-keys the room with a new secret; every phone must pair again" onClick={rotate}>
              <LogOutIcon className="mr-1 h-3.5 w-3.5" />Sign out all phones…
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

/** What the owner calls the connection: Nekko Cloud (the managed relay), Tailscale (this computer's relay), or the URL of their own. */
export function connectionName(relayUrl: string, local: LocalRelayStatus | null): string {
  if (relayUrl === MANAGED_RELAY_URL) return 'Nekko Cloud';
  const here = [local?.tailnetName, local?.tailnetIp].filter(Boolean).map((h) => h!.toLowerCase());
  if (here.includes(relayHost(relayUrl))) return 'Tailscale';
  return relayUrl;
}

/** Whether Nekko Cloud Relay can be ticked: `live`, an upgrade on Free, or not running yet. */
export type CloudAvailability = 'live' | 'upgrade' | 'soon';
export function cloudAvailability(offer: CloudRelayOffer, live = NEKKO_CLOUD_LIVE): CloudAvailability {
  return offer === 'included' ? 'live' : offer === 'upgrade' ? 'upgrade' : live ? 'live' : 'soon';
}

/** A route's own state once it is ticked and remote access is on. */
export interface RouteLive {
  online: boolean;
  error?: string | null;
}

/**
 * *Phones connect through*: Tailscale and Nekko Cloud Relay, tick either or
 * both (decision 0116). Before remote access is on these are the picks the
 * button turns on; after, a tick applies at once and the last one can't be
 * cleared (Disable remote access does that). Tailscale is left out where this
 * computer can't run a relay (the Local Web UI).
 */
export function ConnectThroughView({
  local,
  picks,
  cloud,
  busy,
  live,
  onChange,
  onUpgrade,
}: {
  local: LocalRelayStatus | null;
  picks: RoutePicks;
  cloud: CloudAvailability;
  busy?: boolean;
  /** Set once remote access is on: each ticked route's state, and the last tick stays. */
  live?: { tailscale?: RouteLive; cloud?: RouteLive };
  onChange: (picks: RoutePicks) => void;
  onUpgrade: () => void;
}) {
  const offersTailscale = !!local && local.available !== false;
  const tailnet = !!local?.tailnetIp && !!local.url;
  const on = !!live;
  const count = (picks.tailscale ? 1 : 0) + (picks.cloud ? 1 : 0);
  const lastOne = on && count === 1;
  const state = (ticked: boolean, r?: RouteLive) =>
    on && ticked && r ? (
      <span className={`inline-flex items-center gap-1.5 text-xs ${r.online ? 'text-ink-soft' : 'text-warning-text'}`}>
        <StatusDot tone={r.online ? 'success' : 'warning'} size={7} />
        {r.online ? 'online' : r.error ? 'not connected' : 'connecting…'}
      </span>
    ) : null;
  return (
    <div data-shot="connect-through">
      <h3 className="quiet-group-label">Phones connect through</h3>
      <div role="group" aria-label="Phones connect through" className="-mx-3 mt-(--q-inline)">
        {offersTailscale && (
          <RouteCheckRow
            title="Tailscale"
            meta="Free"
            checked={picks.tailscale}
            disabled={busy || (!picks.tailscale && !tailnet) || (lastOne && picks.tailscale)}
            onToggle={() => onChange({ ...picks, tailscale: !picks.tailscale })}
            state={state(picks.tailscale, live?.tailscale)}
            detail={
              tailnet ? (
                <>Straight to this computer over your tailnet: <span className="font-mono">{local!.tailnetName ?? local!.tailnetIp}</span>. Needs the Tailscale app on the phone too.</>
              ) : (
                <>Tailscale isn’t on here. <a className="underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Get Tailscale</a> and sign in on this computer and your phone.</>
              )
            }
          />
        )}
        <RouteCheckRow
          title="Nekko Cloud Relay"
          meta={cloud === 'soon' ? 'Coming soon' : 'Pro'}
          checked={picks.cloud}
          disabled={busy || cloud === 'soon' || (cloud === 'upgrade' && !picks.cloud) || (lastOne && picks.cloud)}
          onToggle={() => onChange({ ...picks, cloud: !picks.cloud })}
          state={state(picks.cloud, live?.cloud)}
          action={cloud === 'upgrade' && !picks.cloud ? <button className="btn btn-ghost py-1 text-xs" onClick={onUpgrade} disabled={busy}>Upgrade to Pro</button> : undefined}
          detail={<>
            From anywhere, nothing to install. End-to-end encrypted: the relay passes along messages it can’t read.
            {cloud === 'soon' && ' Not running yet.'}
            {on && picks.cloud && live?.cloud && !live.cloud.online && live.cloud.error && <span className="block text-warning-text">{live.cloud.error}</span>}
          </>}
        />
      </div>
      {lastOne && <p className="mt-(--q-tight) text-xs text-ink-faint">At least one way stays on. To stop phones connecting, disable remote access.</p>}
    </div>
  );
}

/** One way in: a tick, its name and a line of detail; disabled shows faint with the reason in the detail. */
function RouteCheckRow({ title, meta, checked, disabled, onToggle, detail, state, action }: {
  title: string;
  meta?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  detail: React.ReactNode;
  state?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="quiet-row items-start py-(--q-inline)">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-start gap-3 text-left disabled:cursor-default"
      >
        <span aria-hidden className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors duration-(--dur-fast) ${checked ? 'bg-accent text-on-accent' : 'bg-surface-2'}`}>
          {checked && <CheckIcon className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={`text-sm font-medium ${disabled && !checked ? 'text-ink-faint' : ''}`}>{title}</span>
            {meta && <span className="text-xs text-ink-faint">{meta}</span>}
          </span>
          <span className="mt-(--q-tight) block text-xs text-ink-faint">{detail}</span>
        </span>
      </button>
      {(state || action) && <span className="flex shrink-0 items-center gap-2">{state}{action}</span>}
    </div>
  );
}

/**
 * How one device connects, or the next one will (decision 0116): the same two
 * ticks, at least one on. Both is *either way*; the computer enforces it at HELLO.
 */
export function DeviceRoutePicks({ label, caption = 'Connects through', value, onChange }: { label: string; caption?: string; value: DeviceRoute; onChange: (r: DeviceRoute) => void }) {
  const p = picksOf(value);
  const set = (next: RoutePicks) => (next.tailscale || next.cloud) && onChange(routeOf(next));
  const item = (key: keyof RoutePicks, name: string) => {
    const checked = p[key];
    const last = checked && !p[key === 'tailscale' ? 'cloud' : 'tailscale'];
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={last || undefined}
        title={last ? 'At least one way stays on' : undefined}
        className={`btn btn-ghost gap-1 py-0.5 text-xs ${checked ? 'text-accent' : 'text-ink-soft'} ${last ? 'cursor-default' : ''}`}
        onClick={() => !last && set({ ...p, [key]: !checked })}
      >
        <CheckIcon aria-hidden className={`h-3 w-3 transition-opacity duration-(--dur-fast) ${checked ? 'opacity-100' : 'opacity-0'}`} />
        {name}
      </button>
    );
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" role="group" aria-label={label}>
      <span className="text-ink-faint">{caption}</span>
      {item('tailscale', ROUTE_LABEL.direct)}
      {item('cloud', ROUTE_LABEL.cloud)}
    </span>
  );
}

/** For self-hosters: a relay of their own, behind a disclosure. */
function OwnRelay({ relayUrl, busy, onRelayUrl, onConnect }: { relayUrl: string; busy?: boolean; onRelayUrl: (url: string) => void; onConnect: () => void }) {
  return (
    <details className="mt-(--q-group) text-xs text-ink-faint">
      <summary className="w-fit cursor-pointer transition-colors duration-(--dur-fast) hover:text-ink">Use your own relay</summary>
      <div className="mt-(--q-inline) flex gap-2">
        <input className="quiet-field py-1.5 text-sm" placeholder="wss://relay.example.com" value={relayUrl} onChange={(e) => onRelayUrl(e.target.value)} />
        <button className="btn btn-ghost py-1 text-xs" onClick={onConnect} disabled={busy || !relayUrl.trim()}>
          <RouterIcon className="mr-1 h-4 w-4" />
          Connect
        </button>
      </div>
      <p className="mt-(--q-tight)">
        <a className="underline" href={SELF_HOST_DOCS} target="_blank" rel="noreferrer">Self-host the relay</a> with one Docker command.
      </p>
    </details>
  );
}

/**
 * Relay on this computer: the app runs the relay itself on this computer's
 * Tailscale address, so phones on the same tailnet need no hosted relay.
 * `onUse` fills the relay field (before remote access is on); `inUse` is the
 * relay in the field (before) or the one remote access is using (after), to say
 * whether it is this one.
 */
export function LocalRelayCard({
  onUse,
  inUse,
  onStatus,
}: {
  onUse?: (url: string) => void;
  inUse?: string;
  /** Every status the card reads, so Remote access can default to this relay. */
  onStatus?: (s: LocalRelayStatus) => void;
}) {
  const [relay, setRelayState] = useState<LocalRelayStatus | null>(null);
  const report = useRef(onStatus);
  report.current = onStatus;
  const setRelay = (s: LocalRelayStatus) => {
    setRelayState(s);
    report.current?.(s);
  };
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
  const setLan = async (on: boolean) => {
    setBusy(true);
    try {
      setRelay(await window.nekko.localRelaySetLan(on));
    } finally {
      setBusy(false);
    }
  };
  return <LocalRelayView relay={relay} busy={busy} onToggle={toggle} onLan={setLan} onUse={onUse} inUse={inUse} />;
}

export function LocalRelayView({
  relay,
  busy,
  onToggle,
  onLan,
  onUse,
  inUse,
}: {
  relay: LocalRelayStatus;
  busy?: boolean;
  onToggle: () => void;
  /** The LAN switch; hidden when absent. */
  onLan?: (on: boolean) => void;
  onUse?: (url: string) => void;
  inUse?: string;
}) {
  const usedHere = !!inUse && !!relay.url && inUse === relay.url;
  const where = relay.tailnetName ?? relay.tailnetIp;

  return (
    <div data-shot="local-relay" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Relay on this computer</h3>
        <span className={`inline-flex items-center gap-1.5 text-xs ${!relay.running && !relay.tailnetIp ? 'text-warning-text' : 'text-ink-soft'}`}>
          <StatusDot tone={relay.running ? 'success' : relay.tailnetIp ? 'neutral' : 'warning'} size={7} />
          {relay.running ? 'running' : relay.enabled ? 'waiting' : 'Tailscale'}
        </span>
        <button className="btn btn-ghost ml-auto py-1 text-xs" onClick={onToggle} disabled={busy}>
          {busy ? (relay.enabled ? 'Stopping…' : 'Starting…') : relay.enabled ? 'Stop' : 'Start relay'}
        </button>
      </div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">
        Phones on your Tailscale network connect straight to this computer over WireGuard, with no hosted relay in
        between. {relay.lan === false ? 'Listens on the tailnet address only.' : 'Listens on the tailnet address and on this computer’s private network addresses.'}
      </p>
      {relay.tailnetIp ? (
        <div className="mt-(--q-inline) flex flex-wrap items-center gap-2 text-xs">
          <StatusDot tone="success" size={7} />
          <span className="text-ink-soft">
            Tailscale connected: <span className="font-mono">{where}</span>
          </span>
        </div>
      ) : (
        <p className="mt-(--q-inline) text-xs text-ink-soft">
          Tailscale isn’t connected on this computer.{' '}
          <a className="underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            Get Tailscale
          </a>
          , sign in on this computer and your phone, and {relay.enabled ? 'the relay starts by itself.' : 'start the relay.'}
        </p>
      )}
      {relay.running && relay.url && (
        <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
          <code className="rounded-lg px-2 py-1 font-mono text-xs" style={{ background: 'var(--surface-2)' }}>
            {relay.url}
          </code>
          {usedHere ? (
            <span className="text-xs text-ink-faint">
              {onUse ? 'Remote access will use this relay.' : 'Remote access is using this relay.'}
            </span>
          ) : onUse ? (
            <button className="btn btn-primary py-1 text-xs" onClick={() => onUse(relay.url!)}>
              Use this relay
            </button>
          ) : null}
        </div>
      )}
      {onLan && (
        <div className="mt-(--q-inline) flex items-start gap-4 py-(--q-inline)">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Also on this Wi-Fi</div>
            <p className="mt-(--q-tight) text-xs text-ink-faint">
              A phone on the same network connects over the LAN and moves to Tailscale by itself when it leaves. Only
              private addresses (192.168.x.x, 10.x.x.x, 172.16.x.x to 172.31.x.x), never the internet. Pair again after changing this.
            </p>
            {relay.running && !!relay.lanUrls?.length && (
              <div className="mt-(--q-inline) flex flex-wrap gap-2">
                {relay.lanUrls.map((u) => (
                  <code key={u} className="rounded-lg px-2 py-0.5 font-mono text-2xs" style={{ background: 'var(--surface-2)' }}>
                    {u}
                  </code>
                ))}
              </div>
            )}
          </div>
          <Toggle value={relay.lan !== false} onChange={onLan} disabled={busy} label="Also on this Wi-Fi" />
        </div>
      )}
      {relay.error && relay.tailnetIp && (
        <p className="mt-(--q-inline) text-xs text-danger-text">
          {relay.error}
        </p>
      )}
    </div>
  );
}

function platformIcon(platform: string): React.ReactNode {
  const cls = 'h-3.5 w-3.5';
  switch (platform) {
    case 'ios':
    case 'android':
      return <PhoneIcon className={cls} />;
    case 'web':
      return <GlobeIcon className={cls} />;
    default:
      return <ComputerIcon className={cls} />;
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

/**
 * Whether paired phones may see the files the agent changed in a chat
 * (`phoneChanges`, on by default). Read only: a phone can never accept or
 * revert changes, read other files or open terminals, and files that may hold
 * secrets are counted, not shown.
 */
/**
 * Visible on this network: the computer answers mDNS so phones on the same
 * Wi-Fi can list it. Off by default. Pairing still takes the QR code or link.
 */
export function NetworkVisibilitySwitch() {
  const [vis, setVis] = useState<NetworkVisibilityStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => void window.nekko.networkVisibilityStatus?.().then((s) => live && setVis(s)).catch(() => {});
    load();
    // Joining a network, or a new address, shows without a click.
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!vis || vis.available === false) return null;
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      setVis(on ? await window.nekko.networkVisibilityStart() : await window.nekko.networkVisibilityStop());
    } catch (e) {
      useStore.getState().pushToast('error', String(e));
    } finally {
      setBusy(false);
    }
  };
  return <NetworkVisibilityView vis={vis} busy={busy} onChange={(on) => void set(on)} />;
}

export function NetworkVisibilityView({ vis, busy, onChange }: { vis: NetworkVisibilityStatus; busy?: boolean; onChange: (on: boolean) => void }) {
  return (
    <SettingRow
      data-shot="network-visibility"
      className="items-start"
      title="Visible on this network"
      detail={<>
        Phones on the same Wi-Fi can find this computer by name. Anyone on the network can see the name
        {vis.relayUrl ? ' and this computer’s relay address' : ''}, nothing else. Pairing still takes this computer’s QR code or link.
        {vis.enabled && vis.advertising && vis.name && (
          <span className="mt-(--q-tight) block text-ink-soft">
            Showing as <span className="font-medium">{vis.name}</span>
            {vis.addresses?.length ? <span className="font-mono"> ({vis.addresses.join(', ')})</span> : null}
          </span>
        )}
        {vis.enabled && vis.error && <span className="mt-(--q-tight) block text-danger-text">{vis.error}</span>}
      </>}
      control={<Toggle value={vis.enabled} onChange={onChange} disabled={busy} label="Visible on this network" />}
    />
  );
}

/** Why a phone's change was refused, in a few words (`PhoneActivityEntry.reason`). */
export function activityReason(reason: string | undefined): string {
  switch (reason) {
    case undefined:
      return 'Done';
    case 'change-off':
      return 'Refused: Change is off';
    case 'proof-required':
    case 'proof-invalid':
    case 'proof-stale':
    case 'proof-replayed':
    case 'key-missing':
    case 'key-invalid':
      return 'Refused: no fresh Face ID or passcode';
    case 'key-mismatch':
      return 'Refused: the phone’s key changed (pair it again)';
    case 'failed':
      return 'Failed on this computer';
    case 'legacy-protocol':
      return 'Refused: update the app on the phone';
    default:
      return `Refused (${reason})`;
  }
}

/** What a channel name means, for the activity list. */
function activityAction(channel: string): string {
  if (channel === PHONE_KEY_CHANNEL) return 'Set up Face ID for changes';
  // The daemon writes this when a phone connects with an app from before relay replay protection.
  if (channel === 'relay:hello') return 'Connected with an older app';
  return channel;
}

/**
 * What phones can do (IO-33): per paired phone, Read and Change switches and
 * the phone's Change activity. Each Change action also needs Face ID or the
 * passcode on the phone within the last 5 minutes, checked by this computer.
 */
export function PhoneAccess({ devices, onChanged }: { devices: RemoteDevice[]; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, PhoneActivityEntry[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadActivity = (id: string) =>
    void window.nekko.getRemoteActivity(id).then((list) => setActivity((a) => ({ ...a, [id]: list }))).catch(() => {});
  useEffect(() => {
    if (!openId) return;
    loadActivity(openId);
    // New changes from a connected phone show without a click.
    const t = setInterval(() => loadActivity(openId), 5000);
    return () => clearInterval(t);
  }, [openId]);

  const set = async (id: string, patch: { read?: boolean; change?: boolean }) => {
    setBusy(id);
    try {
      await window.nekko.setRemoteAccess(id, patch);
      onChanged();
    } catch (e) {
      useStore.getState().pushToast('error', String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <PhoneAccessView
      devices={devices}
      activity={activity}
      openId={openId}
      busyId={busy}
      now={Date.now()}
      onSet={(id, patch) => void set(id, patch)}
      onOpen={(id) => setOpenId((o) => (o === id ? null : id))}
    />
  );
}

export function PhoneAccessView({
  devices,
  activity,
  openId,
  busyId,
  now,
  onSet,
  onOpen,
}: {
  devices: RemoteDevice[];
  activity: Record<string, PhoneActivityEntry[]>;
  openId: string | null;
  busyId?: string | null;
  now: number;
  onSet: (id: string, patch: { read?: boolean; change?: boolean }) => void;
  onOpen: (id: string) => void;
}) {
  if (devices.length === 0) return null;
  return (
    <div data-shot="phone-access">
      <div className="text-sm font-medium">What phones can do</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">
        <span className="font-medium text-ink-soft">Read</span>: see chats, files, git, logs and boards.{' '}
        <span className="font-medium text-ink-soft">Change</span>: send prompts, approve tools, run automations, edit
        and save files, commit and push, type in terminals. File, git and terminal changes, and switching a chat to
        Ask when it matters or No restrictions, need Face ID or the passcode on the phone within the last 5 minutes. Every change is listed
        here. Revoke a phone to stop everything.
      </p>
      <ul className="mt-(--q-inline)">
        {devices.map((d) => {
          const access = phoneDeviceAccess(d);
          const list = activity[d.id];
          const open = openId === d.id;
          return (
            <li key={d.id} className="py-(--q-inline) text-xs" data-device={d.id}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {d.name}
                  {d.legacyProtocol && (
                    <span className="ml-2 text-xs font-normal text-ink-faint">Older app: update it on the phone</span>
                  )}
                </span>
                <label className="flex items-center gap-2 text-ink-soft">
                  Read
                  <Toggle value={access.read} onChange={(v) => onSet(d.id, { read: v })} disabled={busyId === d.id} label={`Read from ${d.name}`} />
                </label>
                <label className="flex items-center gap-2 text-ink-soft">
                  Change
                  <Toggle value={access.change} onChange={(v) => onSet(d.id, { change: v })} disabled={busyId === d.id} label={`Change from ${d.name}`} />
                </label>
                <button className="btn btn-ghost py-1 text-xs" aria-expanded={open} onClick={() => onOpen(d.id)}>
                  {open ? 'Hide activity' : 'Activity'}
                </button>
              </div>
              {open && (
                <div className="mt-(--q-inline)" data-shot="phone-activity">
                  {!list ? (
                    <p className="text-xs text-ink-faint">Loading…</p>
                  ) : list.length === 0 ? (
                    <p className="text-xs text-ink-faint">No changes from this phone yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {list
                        .slice()
                        .reverse()
                        .map((e, i) => (
                          <li key={`${e.at}-${i}`} className="flex items-center gap-2 text-xs">
                            <span className="w-24 shrink-0 text-ink-faint">{ago(e.at, now)}</span>
                            <span className="truncate font-mono text-xs">{activityAction(e.channel)}</span>
                            <span className={`ml-auto shrink-0 ${e.ok ? 'text-success-text' : 'text-danger-text'}`}>
                              {activityReason(e.ok ? undefined : e.reason)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PhoneChangesSwitch() {
  const on = useStore((s) => s.settings?.phoneChanges === true);
  const set = (v: boolean) => {
    void window.nekko.updateSettings({ phoneChanges: v })
      .then(() => useStore.getState().refreshSettings())
      .catch((e) => useStore.getState().pushToast('error', String(e)));
  };
  return (
    <SettingRow
      title="Let phones see changes"
      detail="Paired phones can read the diff of files the agent changed in a chat. Read only: phones can’t accept or revert changes, open other files or terminals. Secret files like .env and keys are hidden."
      control={<Toggle value={on} onChange={set} label="Let phones see changes" />}
    />
  );
}

/**
 * After a phone pressed *Stop remote access on the computer* (SK-3): who
 * stopped it and when, until remote access is turned on again here.
 */
/** Remote access still points at Nekko Cloud while it isn't running: phones can't reach this computer. */
export function CloudGoneBanner({ busy, onChange }: { busy?: boolean; onChange: () => void }) {
  return (
    <div data-shot="cloud-gone" role="alert" className="flex flex-wrap items-center gap-2 rounded-xl px-4 py-2 text-xs text-ink" style={{ background: 'var(--danger-soft)' }}>
      <span className="min-w-0 flex-1">
        Nekko Cloud isn’t running yet, so phones can’t reach this computer through it. Switch to Tailscale, then pair your phone again.
      </span>
      <button className="btn btn-primary py-1 text-xs" onClick={onChange} disabled={busy}>
        Change
      </button>
    </div>
  );
}

export function RemoteStoppedBanner({ stoppedBy, time }: { stoppedBy: { name?: string | null; at: number }; time?: (at: number) => string }) {
  return (
    <p data-shot="remote-stopped" role="status" className="mt-(--q-inline) text-xs text-warning-text">
      {remoteStoppedBanner(stoppedBy, time)}
    </p>
  );
}

/**
 * *Lock phones*: every paired phone keeps Read and loses Change, with one
 * switch instead of each phone's Change switch (`remote:setAccess` for every
 * device, guarded by step-up when it is on: one confirmation covers them all).
 * On while every phone has Change off.
 */
export function LockPhonesSwitch({ devices, onChanged }: { devices: RemoteDevice[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (lock: boolean) => {
    setBusy(true);
    try {
      for (const d of devices) {
        if (phoneDeviceAccess(d).change === !lock) continue;
        await window.nekko.setRemoteAccess(d.id, { change: !lock });
      }
    } catch (e) {
      useStore.getState().pushToast('error', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return <LockPhonesView devices={devices} busy={busy} onChange={(v) => void set(v)} />;
}

export function LockPhonesView({ devices, busy, onChange }: { devices: RemoteDevice[]; busy?: boolean; onChange: (lock: boolean) => void }) {
  if (devices.length === 0) return null;
  const locked = devices.every((d) => !phoneDeviceAccess(d).change);
  return (
    <SettingRow
      data-shot="lock-phones"
      title="Lock phones"
      detail="Every paired phone can still read, but can’t change anything: no prompts, approvals, file or git changes. Turn it off to give each phone its Change switch back."
      control={<Toggle value={locked} onChange={onChange} disabled={busy} label="Lock phones" />}
    />
  );
}

/**
 * *Let a phone quit Nekko Agent* (`quitFromPhone`, SK-3): off by default, so
 * a phone cannot shut down a computer whose owner did not opt in. A phone
 * can never change it.
 */
export function QuitFromPhoneSwitch() {
  const on = useStore((s) => s.settings?.quitFromPhone === true);
  const set = (v: boolean) => {
    void window.nekko.updateSettings({ quitFromPhone: v })
      .then(() => useStore.getState().refreshSettings())
      .catch((e) => useStore.getState().pushToast('error', String(e)));
  };
  return <QuitFromPhoneView on={on} onChange={set} />;
}

export function QuitFromPhoneView({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow
      data-shot="quit-from-phone"
      title="Let a phone quit Nekko Agent"
      detail="A paired phone can quit the app on this computer in an emergency; running chats stop and you start it again here. Stopping remote access from a phone always works, with this on or off."
      control={<Toggle value={on} onChange={onChange} label="Let a phone quit Nekko Agent" />}
    />
  );
}

const PROTECT_PROMPT_KEY = 'nekko.protectComputerPrompt.dismissed';

/**
 * The one-time *Protect this computer* prompt (SK-10): shown while remote
 * access is on and step-up is off, until dismissed (remembered on this
 * device). Points to Settings → Security and the docs page.
 */
export function ProtectComputerPrompt() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(PROTECT_PROMPT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(PROTECT_PROMPT_KEY, '1');
    } catch {
      /* private mode: it shows again next time */
    }
    setHidden(true);
  };
  const setUp = () => {
    document.getElementById(SECURITY_SECTION_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    dismiss();
  };
  return <ProtectComputerPromptView onSetUp={setUp} onDismiss={dismiss} />;
}

export function ProtectComputerPromptView({ onSetUp, onDismiss }: { onSetUp: () => void; onDismiss: () => void }) {
  return (
    <div data-shot="protect-computer" className="min-w-0">
      <div className="text-sm font-medium">Protect this computer</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">
        Remote access is on. Add a security key so pairing a phone, signing phones out, changing what a phone may do or
        touching a provider key needs the key in your hand, not only this computer’s login.
      </p>
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-3 text-xs">
        <button className="btn btn-ghost py-1 text-xs" onClick={onSetUp}>
          Set up in Security
        </button>
        <a className="underline" href={PROTECT_COMPUTER_DOCS_URL} target="_blank" rel="noreferrer">
          How it works
        </a>
        <button className="btn btn-ghost py-1 text-xs" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** The name phones learn on authenticated app:info, with an OS hostname default. */
export function ComputerName() {
  const name = useStore((s) => s.settings?.machineName) ?? '';
  const refreshSettings = useStore((s) => s.refreshSettings);
  const [text, setText] = useState(name);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setText(name); }, [name]);
  useEffect(() => {
    let live = true;
    void window.nekko.getAppInfo().then((info) => { if (live) setHostname(info.systemName ?? info.hostname ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await window.nekko.updateSettings({ machineName: text.trim().slice(0, 40) });
      await refreshSettings();
    } catch {
      setError('Could not save the computer name. Try again.');
    } finally { setBusy(false); }
  };
  return <div className="mt-(--q-group)">
    <label htmlFor="computer-name" className="block text-sm font-medium">Computer name</label>
    <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
      <input id="computer-name" className="quiet-field min-w-0 flex-1 py-1.5 text-sm" maxLength={40} placeholder={hostname || 'Computer name'} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void save(); }} />
      <button className="btn btn-ghost py-1 text-xs" disabled={busy || text.trim() === name} onClick={() => void save()}>Save name</button>
    </div>
    <p className="mt-(--q-tight) text-xs text-ink-faint">Shown on paired phones. Leave blank to use {hostname || 'this computer’s system name'}. You can also rename it just on your phone.</p>
    {error && <p role="alert" className="mt-(--q-tight) text-xs text-danger-text">{error}</p>}
  </div>;
}
