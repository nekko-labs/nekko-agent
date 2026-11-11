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
  /** A short code for the device's public key (16 characters in four groups), to tell devices apart. */
  fingerprint: string | null;
  /** It asked to join: approve it by typing the join code its screen shows. */
  askedToJoin: boolean;
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
    /**
     * While this device waits for approval: the one-time code to type on a
     * device that syncs. It checks this device's key there, and that device
     * here. Never leaves this device except through the user.
     */
    joinCode: string | null;
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

/*
 * Organizations and the shared computer fleet (`org:*` and `fleet:*`, served by
 * `crates/nekko-cloud`). Discovery only: a member sees which computers an
 * organization's members share, never connects to or runs anything on one.
 * Keys and descriptors are decrypted in the daemon; none of it is secret here.
 */

export type OrgRole = 'owner' | 'admin' | 'member';

export interface Org {
  id: string;
  name: string;
  /** The caller's role in it. */
  role: OrgRole;
  /** The organization's current key epoch (0 = no key yet). */
  keyId: number;
  memberCount: number;
  createdAt: string;
}

/** An organization as `org:list` returns it. */
export interface OrgSummary extends Org {
  /** This device holds the organization's current key. */
  hasKey: boolean;
  /** This computer is shared with the organization. */
  sharing: boolean;
}

export interface OrgMember {
  userId: string;
  email: string;
  role: OrgRole;
  addedAt: string;
  you: boolean;
}

/** An invite an owner or admin sent. */
export interface OrgInvite {
  id: string;
  email: string;
  role: Exclude<OrgRole, 'owner'>;
  createdAt: string;
  expiresAt: string;
}

/** An invite addressed to the signed-in account. */
export interface PendingOrgInvite {
  id: string;
  orgId: string;
  orgName: string;
  role: Exclude<OrgRole, 'owner'>;
  /** The email of whoever invited you. */
  invitedBy: string;
  expiresAt: string;
}

export interface OrgList {
  orgs: OrgSummary[];
  invites: PendingOrgInvite[];
}

/** `org:get`. `invites` is empty unless the caller is an owner or admin. */
export interface OrgDetail extends OrgSummary {
  members: OrgMember[];
  invites: OrgInvite[];
}

export type FleetOs = 'windows' | 'macos' | 'linux';

/** A local model a shared computer can serve. No URLs, ports or paths. */
export interface FleetModel {
  id: string;
  label: string;
  runtime: string;
  sizeBytes?: number;
}

export interface FleetComputerView {
  deviceId: string;
  name: string;
  os: FleetOs | string;
  arch: string;
  appVersion: string;
  models: FleetModel[];
  online: boolean;
  /** When the computer last checked in (epoch milliseconds, or an RFC 3339 string). */
  seenAt: number | string | null;
  /** Published by this computer. */
  you: boolean;
  /** Checked against this account's own record of the device. */
  verified: boolean;
  ownerEmail?: string;
}

/** `fleet:list`. `error` is plain text for the person; `rejected` counts descriptors that failed to decrypt. */
export interface FleetList {
  orgId: string;
  orgKeyId: number;
  computers: FleetComputerView[];
  error?: string;
  rejected?: number;
}

export type FleetSharingState = 'off' | 'publishing' | 'online' | 'error';

/** `fleet:setSharing`. */
export interface FleetSharingResult {
  orgId: string;
  sharing: boolean;
  state: FleetSharingState;
}

/** `fleet:status`. */
export interface FleetStatus {
  sharing: Array<{ orgId: string; state: FleetSharingState; lastHeartbeat: number | string | null; error?: string }>;
}
