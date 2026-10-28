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
  /** SK-3: when the phone signed itself out (`device:signOut`), so *Paired devices* says so. */
  signedOutAt?: number;
  /**
   * What this phone may do (IO-33, *What phones can do*): `read` covers
   * read-class channels (the chats too, since 2026-10-22), `change`
   * change-class and agent-class ones (`PHONE_READ_CHANNELS`,
   * `PHONE_CHANGE_CHANNELS`, `PHONE_AGENT_CHANNELS`). Missing, or a missing
   * field, means on. Set with `remote:setAccess`.
   */
  access?: { read?: boolean; change?: boolean };
  /**
   * Its last HELLO came from an app older than relay replay protection
   * (protocol 4): welcomed for one release unless `acceptLegacyPhones` is
   * false in remote.json. Cleared when the phone connects with a newer app.
   */
  legacyProtocol?: boolean;
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
  /** SK-3: the phone that stopped remote access (`remote:stop`) and when, until it is turned on again: the desktop's banner. */
  stoppedBy?: { deviceId: string; name?: string | null; at: number };
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
 * 4 (2026-10-22): relay replay protection. The agent seals each new
 *   connection a `RemoteChallenge`; a HELLO declaring 4 or later must carry
 *   it (single use), and every request after the welcome carries it plus a
 *   rising `seq`. Older phones are legacy: accepted unless the computer's
 *   `acceptLegacyPhones` is false, then refused with `update-required`.
 */
export const REMOTE_PROTOCOL_VERSION = 4;

/** The first protocol whose HELLO answers the agent's challenge (crates/nekko-remote `CHALLENGE_PROTOCOL`). */
export const REMOTE_CHALLENGE_PROTOCOL = 4;

/** Sealed by the agent to a connection the relay just announced (and again after a refused HELLO or request). */
export interface RemoteChallenge {
  type: 'challenge';
  /** 18 random bytes, base64. */
  challenge: string;
}

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
  /** The connection's `RemoteChallenge`, required from protocol 4. */
  challenge?: string;
}

/** A phone's request: from protocol 4 it carries its connection's challenge and a `seq` above every earlier one. */
export interface RemoteRequest {
  type: 'req';
  id: number;
  seq?: number;
  challenge?: string;
  channel: string;
  args: unknown[];
  /** A signed Change proof (`PHONE_CHANGE_PROOF`). */
  proof?: { ts: number; sig: string };
}

export type RemoteDenyReason = 'unknown-device' | 'revoked' | 'bad-code' | 'invalid' | 'update-required';

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

/** The phone channel the relay agent answers itself: the Live Activity card's level, focus or dismissal (crates/nekko-remote `CARD_CHANNEL`). */
export const CARD_CHANNEL = 'card:set';

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
 *   agent → relay : { type:'activity', tag, phase, callId?, severity? } (per-chat Live Activity, older iPhones)
 *   agent → relay : { type:'card', state } | { type:'card-start', state } (the iPhone's one Live Activity card)
 *   client → relay: { type:'register-push', token, platform, deviceId, kinds? }
 *   client → relay: { type:'register-activity', deviceId, tag, token, app? } (older iPhones)
 *   client → relay: { type:'register-card', deviceId, token?, startToken?, level, computerId, computerName, app? }
 *   relay → client: { type:'agent-online' } | { type:'agent-offline' }
 *   relay → client: { type:'push-registered', delivers } | { type:'dismiss', tag }
 *
 * The Live Activity card (always-on voice, Part 4). An iPhone shows one card
 * for all of a computer's chats (`LiveCardState` in apps/ios LiveCard.swift).
 * It registers the card's ActivityKit push token (`token`, while a card is up)
 * and its push-to-start token (`startToken`, iOS 17.2 and later) with the
 * relay, with its `level` ('minimal' | 'standard' | 'detailed'; 'none' drops
 * the registration) and the computer's id and name for a started card's
 * attributes. Over the sealed connection it tells the computer its level, a
 * chip tap and a closed chat with `CARD_CHANNEL` (`{ level?, focus?, dismiss? }`,
 * answered by the relay agent itself). While any phone wants a card the
 * computer builds it with the app's rules (crates/nekko-remote card.rs, both
 * held to fixtures/live-card.json) and sends `card` when it changes; dates are
 * seconds since 2001, as ActivityKit decodes them. It includes chat text
 * only when some phone asked for Standard or Detailed. The relay pushes
 * `event: 'update'` to every registered card, or `'end'` when `state.chats`
 * is empty, blanking the title, step and reply at Minimal and the reply at
 * Standard, with step and reply cut to 60 characters and the payload under
 * 4 KB. `card-start` (a run in a chat a phone sent `chat:send`/`chat:queue`
 * to in the last two hours, or one a watch woke) also pushes `event: 'start'`
 * with `attributes-type: 'NekkoCardAttributes'` to each phone with no card up
 * and no open socket in the room, once until it registers again. A push that
 * only changes a step, a reply or a time goes at APNs priority 5, anything
 * else at 10; `computerId` and `computerName` are kept to 64 UTF-8 bytes. Unlike every other push the card carries
 * chat text in the clear (ActivityKit draws only what the push holds), so it
 * passes through the relay and Apple's push service at Standard and Detailed.
 * APNs delivery and push-to-start are unverified until the relay has the
 * production APNs key and a device runs it.
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
