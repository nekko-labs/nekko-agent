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
 * What a content-free push is about, so a phone can ask its relay for only
 * some of them (`register-push` `kinds`). `test` is the phone's own
 * *Send a test notification* and always goes to that one phone.
 */
export type PushKind = 'needs-you' | 'finished' | 'failed' | 'test';
export const PUSH_KINDS: readonly PushKind[] = ['needs-you', 'finished', 'failed'];

/* ------------------------------------------------------------------------- *
 * Random material. Uses WebCrypto (browser + Node 20+).
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * Relay wire protocol (plain-JSON routing envelopes; payload stays ciphertext).
 * ------------------------------------------------------------------------- */
