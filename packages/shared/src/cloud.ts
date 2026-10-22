/**
 * Nekko Cloud sign-in and end-to-end encrypted sync, as the engine daemon
 * reports it (`crates/nekko-cloud`, channels `cloud:*` and `sync:*`). Nothing
 * here is secret: keys and tokens stay in the daemon's vault.
 */

export type SyncPhase =
  | 'signed-out'
  | 'needs-plan'
  | 'off'
  | 'needs-join'
  | 'awaiting-approval'
  | 'syncing'
  | 'idle'
  | 'paused'
  | 'error';

export interface SyncDevice {
  id: string;
  label: string | null;
  /** 16 characters in four groups, to compare on both screens before approving. */
  fingerprint: string | null;
  createdAt: string | null;
  revoked: boolean;
  /** Listed in the account's sealed record (approved, or joined with the recovery key). */
  trusted: boolean;
  thisDevice: boolean;
}

export interface CloudStatus {
  signedIn: boolean;
  account: { email: string; plan: 'free' | 'pro' | 'team' | string; canSync: boolean } | null;
  /** A browser sign-in (GitHub, Google, Apple) is waiting for its callback. */
  oauthPending: boolean;
  /** Where this device's keys live ("macOS Keychain"…). */
  keysStoredIn: string;
  sync: {
    phase: SyncPhase;
    enabled: boolean;
    includeLocalOnly: boolean;
    recoveryConfirmed: boolean;
    keyEpoch: number | null;
    lastSyncAt: number | null;
    error: string | null;
    progress: { done: number; total: number } | null;
    chats: number;
    pushed: number;
    pulled: number;
    skipped: Partial<Record<'incognito' | 'localOnly' | 'tooLarge', number>>;
    fingerprint: string | null;
    devices: SyncDevice[];
    usage: { bytes: number; limit: number } | null;
  };
}

export type CloudOAuthProvider = 'github' | 'google' | 'apple';

/** `sync:turnOn` on an account's first device: the recovery key, shown once. */
export interface SyncTurnOnResult {
  recoveryKey?: string;
  status: CloudStatus;
}

/** The daemon refuses `sync:turnOn` with this prefix when the account already syncs elsewhere. */
export const NEEDS_JOIN = 'needs-join:';

/** Strips the machine prefix from a daemon error for display. */
export function cloudError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.startsWith(NEEDS_JOIN) ? m.slice(NEEDS_JOIN.length).trim() : m;
}
