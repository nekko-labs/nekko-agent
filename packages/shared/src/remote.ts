/**
 * Remote access (phone remote control) over the relay.
 *
 * Security model, in one paragraph: the local agent dials OUT to a relay and
 * claims a room with a pairing secret; devices (phones) present a credential
 * derived from the same secret to the relay. That secret gets a device onto the
 * relay and no further. Each connection then runs a key exchange the agent signs
 * with its host key, which the device pinned from its pairing link, so all
 * payloads are sealed under a key only that connection's two ends hold (decision
 * 0041) and the relay only ever routes ciphertext. Every device must complete an
 * application-level HELLO handshake with the agent: known + not-revoked devices
 * are welcomed, brand-new devices are enrolled only with a short-lived
 * single-use pairing code, a revoked device comes back only the same way (a
 * fresh code from the owner), and everything else is denied. A revoked device
 * that kept its old link can't pose as the computer or read anyone's traffic.
 * It can still reach the relay, so rotating the secret remains the way to shut
 * it out of the room: it forces every device to re-pair.
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
  /** The computer's public key, which a device pins (X9.63 P-256, base64). */
  hostKey?: string;
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
 * 5 (2026-11-01): device-key HELLOs (decision 0036). The HELLO carries the
 *   device's P-256 public key (`helloKey`) and a signature (`sig`) of
 *   `helloText(deviceId, room, challenge)`; a device enrolls its key with the
 *   pairing code and must sign every later HELLO with it. Anything older is
 *   refused with `update-required`, and a device without an enrolled key with
 *   `bad-key` (pair again).
 * 6 (2026-11-02): the computer proves itself and each connection has its own
 *   key (decision 0041). The challenge carries the computer's ephemeral key
 *   (`eph`) and its host key's signature (`sig`) of `hostText`; the device
 *   checks that against the host key pinned from its link, and answers
 *   `{eph, enc}`: its own ephemeral key beside the HELLO sealed under
 *   `sessionKey`. Everything after is sealed under that key. Anything older is
 *   refused with `update-required`.
 */
export const REMOTE_PROTOCOL_VERSION = 6;

/** The first protocol whose HELLO is signed with a device key (crates/nekko-remote `HELLO_KEY_PROTOCOL`). */
export const REMOTE_HELLO_KEY_PROTOCOL = 5;

/**
 * What a HELLO signs with the device key (ECDSA P-256 SHA-256, raw r||s):
 * `nekko-hello-v2`, the deviceId, the room, the challenge and both ephemeral
 * keys, one per line, so a signature is good for this one exchange.
 */
export function helloText(deviceId: string, room: string, challenge: string, hostEph: string, clientEph: string): string {
  return ['nekko-hello-v2', deviceId, room, challenge, hostEph, clientEph].join(String.fromCharCode(10));
}

/** What a computer signs with its host key in a challenge. */
export function hostText(room: string, challenge: string, hostEph: string): string {
  return ['nekko-host-v1', room, challenge, hostEph].join(String.fromCharCode(10));
}

/** The HKDF info of a connection's key. */
export function sessionInfo(room: string, challenge: string, hostEph: string, clientEph: string): string {
  return ['nekko-session-v1', room, challenge, hostEph, clientEph].join(String.fromCharCode(10));
}

/** Whether `sig` is the pinned host key's signature of this challenge. Anything malformed is false. */
export async function challengeIsGenuine(hostKey: string, room: string, c: { challenge: string; eph: string; sig: string }): Promise<boolean> {
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(hostKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(c.sig), new TextEncoder().encode(hostText(room, c.challenge, c.eph)));
  } catch {
    return false;
  }
}

/** `helloKey` (X9.63 public key, base64) and `sig` (raw r||s, base64) for a HELLO in this exchange. */
export async function helloProof(keys: CryptoKeyPair, deviceId: string, room: string, challenge: string, hostEph: string, clientEph: string): Promise<{ helloKey: string; sig: string }> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const text = helloText(deviceId, room, challenge, hostEph, clientEph);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(text)));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return { helloKey: b64(raw), sig: b64(sig) };
}

/** The first protocol whose HELLO answers the agent's challenge (crates/nekko-remote `CHALLENGE_PROTOCOL`). */
export const REMOTE_CHALLENGE_PROTOCOL = 4;

/** Sealed by the agent to a connection the relay just announced (and again after a refused HELLO or request). */
export interface RemoteChallenge {
  type: 'challenge';
  /** 18 random bytes, base64. */
  challenge: string;
  /** The computer's half of the key exchange, X9.63 P-256, base64. */
  eph: string;
  /** The host key's signature of `hostText`, raw r||s, base64. */
  sig: string;
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
  /** From protocol 5: the device's P-256 public key, X9.63 uncompressed, base64. */
  helloKey?: string;
  /** From protocol 5: `helloKey`'s signature of `helloText`, raw r||s, base64. */
  sig?: string;
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
