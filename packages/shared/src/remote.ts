/**
 * Remote access (phone remote control) over the relay.
 *
 * Security model, in one paragraph: the local agent dials OUT to a relay and
 * claims a room with a pairing secret; devices (phones) present the same secret
 * to the relay (transport auth) and all payloads are end-to-end encrypted with a
 * key derived from that secret, so the relay only ever routes ciphertext. On top
 * of that transport, every device must complete an application-level HELLO
 * handshake with the agent: known + not-revoked devices are welcomed, brand-new
 * devices are enrolled only with a short-lived single-use pairing code, a
 * revoked device comes back only the same way (a fresh code from the owner),
 * and everything else is denied. The agent unicasts responses and events per device
 * (never broadcast), so a revoked device receives nothing even while it still
 * holds the old link. Rotating the secret is the cryptographic kill switch: it
 * re-keys the room and forces every device to re-pair.
 */

/** A phone/browser paired to this machine for remote control. */
export interface RemoteDevice {
  /** Stable client-generated id (persisted on the device). */
  id: string;
  /** Friendly name, e.g. "Philip's iPhone". Renameable in Settings. */
  name: string;
  /** Best-effort platform tag: 'ios' | 'android' | 'web' | 'unknown'. */
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  /** Revoked devices are denied at HELLO and kicked if connected. */
  revoked?: boolean;
  /**
   * What this phone may do beyond the chat (IO-33, *What phones can do*):
   * `read` covers read-class channels, `change` change-class ones
   * (`PHONE_READ_CHANNELS` / `PHONE_CHANGE_CHANNELS`). Missing, or a missing
   * field, means on. Set with `remote:setAccess`.
   */
  access?: { read?: boolean; change?: boolean };
  /**
   * The phone's public key for Change proofs (base64 X9.63 P-256), registered
   * by the phone itself over `device:registerKey` on its first Change action.
   * Trust on first use; pairing again starts a fresh record without it.
   */
  changeKey?: string;
  /** When `changeKey` was registered. */
  changeKeyAt?: number;
}

/** A short-lived, single-use enrollment code for pairing a new device. */
export interface PairingGrant {
  code: string;
  expiresAt: number;
}

/** How long a pairing code stays valid. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Remote-access status for the Settings UI. */
export interface RemoteStatus {
  enabled: boolean;
  relayUrl?: string;
  room?: string;
  hasKey?: boolean;
  /** Registered devices (including revoked ones, so the UI can show history). */
  devices?: RemoteDevice[];
  /** Device ids with a live relay connection right now. */
  connected?: string[];
  /** True when the agent's relay socket is currently open. */
  online?: boolean;
  error?: string;
}

export interface RemotePairing {
  relayUrl: string;
  room: string;
  key: string;
}

/* ------------------------------------------------------------------------- *
 * Application-level handshake frames (E2E-sealed; the relay can't read them).
 * ------------------------------------------------------------------------- */

/**
 * The phone protocol version this computer speaks. A phone sends its own in
 * the HELLO and the agent answers with this one in the welcome, so the phone
 * can say which side to update when they differ. Phones and computers from
 * before the field count as 1. Raise it when a phone feature needs something
 * new from the computer (or the other way round).
 *
 * 2 (2026-10-19): `push:test`, notification kinds and dismissal frames.
 * 3 (2026-10-20): git from a phone (IO-33 FA-2), the first Change actions.
 */
export const REMOTE_PROTOCOL_VERSION = 3;

/** First sealed frame a device sends after connecting. */
export interface RemoteHello {
  type: 'hello';
  deviceId: string;
  name?: string;
  platform?: string;
  /** One-time pairing code, present only on first-time enrollment. */
  pair?: string;
  /** The phone's `REMOTE_PROTOCOL_VERSION`; absent means 1. */
  protocol?: number;
}

export type RemoteDenyReason = 'unknown-device' | 'revoked' | 'bad-code' | 'invalid';

/** Agent's sealed reply to a HELLO. The relay agent adds `protocol` to a welcome. */
export type RemoteHelloReply =
  | { type: 'welcome'; device: RemoteDevice; protocol?: number }
  | { type: 'denied'; reason: RemoteDenyReason };

/**
 * What a content-free push is about, so a phone can ask its relay for only
 * some of them (`register-push` `kinds`). `test` is the phone's own
 * *Send a test notification* and always goes to that one phone.
 */
export type PushKind = 'needs-you' | 'finished' | 'failed' | 'test';
export const PUSH_KINDS: readonly PushKind[] = ['needs-you', 'finished', 'failed'];

/** The phone channel the relay agent answers itself: a test push to the asking phone. */
export const PUSH_TEST_CHANNEL = 'push:test';

/** Outcome of validating a HELLO against the device registry. Pure; host applies it. */
export type HelloVerdict =
  | { action: 'welcome'; device: RemoteDevice; enrolled: boolean }
  | { action: 'deny'; reason: RemoteDenyReason };

/**
 * Validate a device HELLO. Known devices are welcomed unless revoked; unknown
 * devices enroll only with a live pairing code. A revoked device is re-admitted
 * only with a live pairing code too: the same proof a new phone needs, made on
 * the computer by its owner, single use. A phone keeps its device id across
 * "forget this computer", so without this a revoked phone could never pair
 * again short of rotating the room secret. Pure so it's unit-testable; the
 * caller persists the returned device (new or lastSeen-updated) and consumes the
 * pairing grant when `enrolled` is true.
 */
export function verifyHello(
  devices: RemoteDevice[],
  hello: unknown,
  pairing: PairingGrant | null,
  now: number,
): HelloVerdict {
  const h = hello as RemoteHello | null;
  if (!h || h.type !== 'hello' || typeof h.deviceId !== 'string' || !h.deviceId.trim()) {
    return { action: 'deny', reason: 'invalid' };
  }
  const known = devices.find((d) => d.id === h.deviceId);
  if (known && !known.revoked) {
    return { action: 'welcome', device: { ...known, lastSeenAt: now }, enrolled: false };
  }
  // A revoked device with no code is told it was removed; one that brings a
  // code is pairing again, so it is checked exactly like a new device and gets
  // a fresh registry entry.
  if (!h.pair) return { action: 'deny', reason: known ? 'revoked' : 'unknown-device' };
  if (!pairing || pairing.code !== h.pair || pairing.expiresAt <= now) {
    return { action: 'deny', reason: 'bad-code' };
  }
  // A device sends these, so a non-string is ignored rather than trusted (a
  // number here used to throw, leaving the phone with no reply at all).
  const name = typeof h.name === 'string' ? h.name : '';
  const platform = typeof h.platform === 'string' ? h.platform : undefined;
  const device: RemoteDevice = {
    id: h.deviceId,
    name: name.trim().slice(0, 60) || defaultDeviceName(platform),
    platform: normalizePlatform(platform),
    createdAt: now,
    lastSeenAt: now,
  };
  return { action: 'welcome', device, enrolled: true };
}

export function normalizePlatform(p?: string): string {
  const v = (p || '').toLowerCase();
  return v === 'ios' || v === 'android' || v === 'web' ? v : 'unknown';
}

export function defaultDeviceName(platform?: string): string {
  switch (normalizePlatform(platform)) {
    case 'ios':
      return 'iPhone';
    case 'android':
      return 'Android phone';
    case 'web':
      return 'Browser';
    default:
      return 'Device';
  }
}

/* ------------------------------------------------------------------------- *
 * Random material. Uses WebCrypto (browser + Node 20+).
 * ------------------------------------------------------------------------- */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** Human-typeable one-time pairing code (~40 bits with the 31-char alphabet). */
export function newPairingCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Room code (routing only, not secret, but unguessable). */
export function newRoomCode(): string {
  return hex(crypto.getRandomValues(new Uint8Array(8)));
}

/** Pairing secret: 128-bit hex. Feeds relay transport auth + PBKDF2 → AES-GCM. */
export function newRoomSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/* ------------------------------------------------------------------------- *
 * Relay wire protocol (plain-JSON routing envelopes; payload stays ciphertext).
 * ------------------------------------------------------------------------- */

/**
 * Relay v2 frames. The relay tags each client connection with a `cid` and the
 * agent addresses replies/events per-cid, so devices only ever receive their own
 * traffic (plus events the agent chooses to fan out to welcomed devices).
 *
 *   relay → agent : { type:'client-open', cid } | { type:'client-close', cid }
 *   relay → agent : { type:'c', cid, data }        (data = client's raw frame)
 *   agent → relay : { type:'d', cid, data }        (unicast to one client)
 *   agent → relay : { type:'kick', cid }           (relay closes that client)
 *   agent → relay : { type:'notify', kind, tag?, deviceId?, title, body } (content-free push trigger)
 *   agent → relay : { type:'dismiss', tag }        (a needs-you push was handled)
 *   agent → relay : { type:'push-remove', deviceId }
 *   client → relay: { type:'register-push', token, platform, deviceId, kinds? }
 *   relay → client: { type:'agent-online' } | { type:'agent-offline' }
 *   relay → client: { type:'push-registered', delivers } | { type:'dismiss', tag }
 */
export interface RelayClientOpen {
  type: 'client-open';
  cid: string;
}
export interface RelayClientClose {
  type: 'client-close';
  cid: string;
}
export interface RelayFromClient {
  type: 'c';
  cid: string;
  data: string;
}
export interface RelayToClient {
  type: 'd';
  cid: string;
  data: string;
}
export interface RelayKick {
  type: 'kick';
  cid: string;
}
