import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PAIRING_TTL_MS,
  newPairingCode,
  newRoomCode,
  newRoomSecret,
  verifyHello,
  type PairingGrant,
  type RemoteDevice,
  type RemoteHelloReply,
  type RemotePairing,
  type RemoteStatus,
} from '@nekko-agent/shared';
import { dataDir } from './store.js';
import { ensurePrivateFile, writeJsonAtomic } from './secure-file.js';
import { connectRelayAgent, type RelayAgentHandle } from './relay.js';
import type { Host } from './host.js';

/**
 * Remote access (phone remote control): owns the persisted relay config + the
 * paired-device registry, and the live relay-agent connection. The registry is
 * the auth layer: a device must complete the E2E HELLO handshake against it
 * before the agent serves a single request, new devices enroll only through a
 * short-lived single-use pairing code, and revoking a device kicks it live.
 * Config persists to remote.json so remote access survives restarts (the agent
 * reconnects on boot when enabled).
 */

/**
 * What the daemon puts in `NEKKOD_OWNS` when it runs remote access itself
 * (crates/nekko-remote): remote.json and the relay agent. The desktop and the
 * web edition behind nekkod then never start this service's agent; the
 * headless relay-agent mode and the editions without a daemon still do.
 */
export const DAEMON_REMOTE = 'remote';

interface RemoteConfig {
  enabled: boolean;
  relayUrl?: string;
  room?: string;
  secret?: string;
  devices: RemoteDevice[];
}

function file(): string {
  const dir = dataDir();
  return join(dir, 'remote.json');
}

function load(): RemoteConfig {
  try {
    ensurePrivateFile(file());
    const cfg = JSON.parse(readFileSync(file(), 'utf8')) as Partial<RemoteConfig>;
    return { enabled: cfg.enabled ?? false, relayUrl: cfg.relayUrl, room: cfg.room, secret: cfg.secret, devices: cfg.devices ?? [] };
  } catch {
    return { enabled: false, devices: [] };
  }
}

function save(cfg: RemoteConfig): RemoteConfig {
  writeJsonAtomic(file(), cfg);
  return cfg;
}

export interface RemoteService {
  enable(relayUrl: string): RemoteStatus;
  disable(): RemoteStatus;
  status(): RemoteStatus;
  pairing(): RemotePairing | null;
  /** Mint a short-lived, single-use pairing code for enrolling a new device. */
  pair(): PairingGrant;
  devices(): RemoteDevice[];
  revoke(deviceId: string): RemoteDevice[];
  rename(deviceId: string, name: string): RemoteDevice[];
  /** New room + secret; wipes the registry, every device must re-pair. */
  rotate(): RemoteStatus;
  /** Reconnect on host boot when remote access was left enabled. */
  startIfEnabled(): void;
  /** Enable with explicit creds (headless relay-agent mode). */
  attach(opts: { relayUrl: string; room: string; secret: string }): RemoteStatus;
  stop(): void;
}

export function createRemoteService(host: Host): RemoteService {
  let handle: RelayAgentHandle | null = null;
  let grant: PairingGrant | null = null;

  const liveGrant = (): PairingGrant | null => (grant && grant.expiresAt > Date.now() ? grant : null);

  const verify = (hello: unknown): RemoteHelloReply => {
    const cfg = load();
    const verdict = verifyHello(cfg.devices, hello, liveGrant(), Date.now());
    if (verdict.action === 'deny') return { type: 'denied', reason: verdict.reason };
    const devices = cfg.devices.filter((d) => d.id !== verdict.device.id);
    devices.push(verdict.device);
    save({ ...cfg, devices });
    if (verdict.enrolled) grant = null; // single use
    return { type: 'welcome', device: verdict.device };
  };

  const connect = (cfg: RemoteConfig) => {
    handle?.stop();
    handle = connectRelayAgent(host, {
      relayUrl: cfg.relayUrl!,
      room: cfg.room!,
      key: cfg.secret!,
      verify,
    });
  };

  const statusOf = (cfg: RemoteConfig): RemoteStatus =>
    cfg.enabled
      ? {
          enabled: true,
          relayUrl: cfg.relayUrl,
          room: cfg.room,
          hasKey: !!cfg.secret,
          devices: cfg.devices,
          connected: handle?.connectedDevices() ?? [],
          online: handle?.isOnline() ?? false,
          error: handle?.lastError(),
        }
      : { enabled: false, devices: cfg.devices };

  return {
    enable(relayUrl) {
      const prev = load();
      const cfg = save({
        ...prev,
        enabled: true,
        relayUrl,
        room: prev.room ?? newRoomCode(),
        secret: prev.secret ?? newRoomSecret(),
      });
      connect(cfg);
      return statusOf(cfg);
    },
    attach({ relayUrl, room, secret }) {
      const cfg = save({ ...load(), enabled: true, relayUrl, room, secret });
      connect(cfg);
      return statusOf(cfg);
    },
    disable() {
      handle?.stop();
      handle = null;
      grant = null;
      return statusOf(save({ ...load(), enabled: false }));
    },
    status: () => statusOf(load()),
    pairing: () => {
      const cfg = load();
      if (!cfg.enabled || !cfg.relayUrl || !cfg.room || !cfg.secret) return null;
      return { relayUrl: cfg.relayUrl, room: cfg.room, key: cfg.secret };
    },
    pair() {
      grant = { code: newPairingCode(), expiresAt: Date.now() + PAIRING_TTL_MS };
      return grant;
    },
    devices: () => load().devices,
    revoke(deviceId) {
      const cfg = load();
      const devices = cfg.devices.map((d) => (d.id === deviceId ? { ...d, revoked: true } : d));
      save({ ...cfg, devices });
      handle?.kickDevice(deviceId);
      return devices;
    },
    rename(deviceId, name) {
      const cfg = load();
      const clean = name.trim().slice(0, 60);
      const devices = cfg.devices.map((d) => (d.id === deviceId && clean ? { ...d, name: clean } : d));
      return save({ ...cfg, devices }).devices;
    },
    rotate() {
      const prev = load();
      const cfg = save({ ...prev, room: newRoomCode(), secret: newRoomSecret(), devices: [] });
      grant = null;
      if (cfg.enabled && cfg.relayUrl) connect(cfg);
      return statusOf(cfg);
    },
    startIfEnabled() {
      const cfg = load();
      if (cfg.enabled && cfg.relayUrl && cfg.room && cfg.secret) connect(cfg);
    },
    stop() {
      handle?.stop();
      handle = null;
    },
  };
}
