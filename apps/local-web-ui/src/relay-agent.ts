import { pairingLink } from '@nekko-agent/shared';
import { daemonRequest, startNekkod } from 'nekko-agent/engine';

/**
 * Relay-agent mode for the server CLI: start nekkod on the data directory and
 * point its relay agent (crates/nekko-remote, the same one the desktop's
 * remote access uses) at a relay room, so headless agents get the same device
 * registry, pairing codes and revocation. Prints a one-time pairing code at
 * boot; more devices can be paired later from the UI (or by restarting). Runs
 * until stopped; nekkod and its backend stop with it.
 */
/** What a Nekko Cloud machine is told to let the cloud see (`NEKKO_CLOUD_SCOPE`, decision 0017). */
export interface CloudScope {
  repos?: string[];
  privacyShield?: boolean;
  memory?: boolean;
  syncBack?: boolean;
}

/** `NEKKO_CLOUD_SCOPE` parsed, or null when unset or unreadable. */
export function parseCloudScope(raw: string | undefined): CloudScope | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return {
      repos: Array.isArray(o.repos) ? o.repos.filter((r): r is string => typeof r === 'string') : [],
      privacyShield: o.privacyShield !== false,
      memory: o.memory === true,
      syncBack: o.syncBack !== false,
    };
  } catch {
    return null;
  }
}

/**
 * The settings a scope pins on the machine: Privacy Shield on by default for
 * every cloud model request. Memory and connectors are simply absent on a
 * fresh machine; the scope's `memory` switch only ever lets the phone copy
 * some up later, it never reaches back to a computer.
 */
export function scopeSettings(scope: CloudScope): Record<string, unknown> {
  return scope.privacyShield === false ? {} : { privacyMode: 'shield' };
}

/**
 * A minted code pairs a new machine once. Every later boot must leave it dead, or
 * it lets a device that was removed back in. The list keeps revoked devices.
 */
export function armsMintedCode(devices: unknown[]): boolean {
  return devices.length === 0;
}

/** A Nekko Cloud machine stops itself after this long with no device connected and no chat running. */
export const IDLE_STOP_MS = 15 * 60_000;

/** Idle: no paired device on the relay (`remote:status`) and no chat running (`chat:running`). */
export function isIdle(status: { connected?: unknown } | null | undefined, running: unknown): boolean {
  const any = (v: unknown) => Array.isArray(v) && v.length > 0;
  return !any(status?.connected) && !any(running);
}

/** Feed it whether the machine is idle at each check; it says when the machine has been idle for `limitMs`. */
export function idleClock(limitMs: number, start = Date.now()): (idle: boolean, at?: number) => boolean {
  let since = start;
  return (idle, at = Date.now()) => {
    if (!idle) since = at;
    return at - since >= limitMs;
  };
}

export async function runRelayAgent(opts: {
  relayUrl: string;
  room: string;
  key: string;
  dataDir: string;
  here: string;
  /** A pairing code minted elsewhere (a Nekko Cloud machine's), used instead of a random one. */
  pairCode?: string;
  /** A host key minted elsewhere (a Nekko Cloud machine's), whose public half is in its link. */
  hostKey?: string;
  /** A Nekko Cloud machine's scope, applied before the relay is joined. */
  scope?: CloudScope | null;
  /**
   * A Nekko Cloud machine's idle limit: past it the agent exits cleanly, and
   * the host (restart only on failure) leaves the machine stopped, disk kept.
   */
  idleStopMs?: number;
}): Promise<void> {
  const { daemon } = await startNekkod({ here: opts.here, dataDir: opts.dataDir });
  const stop = () => void daemon.stop().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (opts.scope) {
      const settings = scopeSettings(opts.scope);
      if (Object.keys(settings).length) await daemonRequest(daemon, 'settings:update', settings);
    }
    await daemonRequest(daemon, 'remote:attach', { relayUrl: opts.relayUrl, room: opts.room, secret: opts.key, hostKey: opts.hostKey });
    // A printed code is a promise that the agent is in the room: wait for the
    // relay connection, so a device that connects at once is answered.
    for (let i = 0; i < 100; i++) {
      const status = await daemonRequest<{ online?: boolean; error?: string }>(daemon, 'remote:status');
      if (status.online) break;
      if (i === 99) console.warn(`[nekko-agent] relay not reachable yet${status.error ? ` (${status.error})` : ''}; still trying in the background.`);
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`\nNekko Agent relay-agent → ${opts.relayUrl}`);
    if (!opts.pairCode) {
      const grant = await daemonRequest<{ code: string }>(daemon, 'remote:pair');
      const { hostKey } = await daemonRequest<{ hostKey?: string }>(daemon, 'remote:pairing');
      console.log(`   room=${opts.room}  key=${opts.key}`);
      console.log(`   one-time pairing code (10 min): ${grant.code}`);
      console.log(`   pairing link: ${pairingLink('<ui-origin>/', { relayUrl: opts.relayUrl, room: opts.room, key: opts.key, hostKey, pair: grant.code })}`);
    } else if (armsMintedCode(await daemonRequest<unknown[]>(daemon, 'remote:devices'))) {
      // Machine logs are kept by the host, so the code and key aren't printed.
      await daemonRequest(daemon, 'remote:pair', opts.pairCode);
    }
    console.log(`   serving this machine's model + tools to paired devices (data: ${opts.dataDir})\n`);
    if (opts.idleStopMs) {
      // shortcut: scheduled tasks don't keep the machine awake; add them here when cloud machines run schedules.
      const limit = opts.idleStopMs;
      const overLimit = idleClock(limit);
      setInterval(async () => {
        // A failed check counts as busy: never stop a machine we can't see into.
        const idle = await Promise.all([daemonRequest(daemon, 'remote:status'), daemonRequest(daemon, 'chat:running')])
          .then(([status, running]) => isIdle(status as { connected?: unknown }, running))
          .catch(() => false);
        if (overLimit(idle)) {
          console.log(`[nekko-agent] idle for ${Math.round(limit / 60_000)} minutes, stopping this machine`);
          stop();
        }
      }, Math.min(60_000, limit)).unref();
    }
  } catch (e) {
    await daemon.stop();
    throw e;
  }
}
