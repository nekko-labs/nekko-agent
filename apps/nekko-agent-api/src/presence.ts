import type { FastifyInstance } from "fastify";

/**
 * Fleet presence, kept in this process (docs: spec/platform/organizations.md).
 *
 * A computer that shares itself beats every 30 s. A beat used to be a transaction with two
 * advisory locks, about four reads and an UPDATE of `seen_at`, so an idle shared computer cost
 * thousands of writes a day. Now a beat renews a lease here and writes `seen_at` to the database
 * only when the computer comes online (no live lease) or when the stored value is an hour old.
 * The database value is the "last seen" for an offline computer and what a restart reads back.
 *
 * Also kept here, for a few minutes: what a successful beat established about the caller (their
 * row, their membership, the key epoch), so the next beats skip those checks. Anything the API
 * itself changes that could end that (a member removed, a device revoked, a key rotated, sync
 * deleted) drops the entries (`forget*`); the rest is revalidated when an entry expires.
 *
 * One process only. The API is one Fly machine (min 1, auto-stop off): a second machine would
 * not see the first one's leases, so scaling out needs a shared store, or presence from the
 * relay (`relay-presence.ts`), before this is safe.
 */
export const LEASE_MS = 90_000;
/** How long a beat's checks are trusted before the full path runs again. */
export const IDENTITY_MS = 5 * 60_000;
/** The stored `seen_at` is refreshed at least this often while a computer keeps beating. */
export const DB_WRITE_MS = 60 * 60_000;
/** After a start, a `seen_at` newer than DB_WRITE_MS counts as online for this long, so a restart does not flash every computer offline. */
export const BOOT_WINDOW_MS = 90_000;
const MAX_ENTRIES = 50_000;

export interface Identity {
  userId: string;
  deviceId: string;
  tokenId: string;
  /** The key epoch the beat was validated against: the org's, or the account's for the personal fleet. */
  keyId: number;
}

interface Entry {
  /** `orgId` for an org fleet row, null for the account's own fleet. */
  orgId: string | null;
  identity: Identity;
  validatedAt: number;
  lastBeat: number;
  lastDbWrite: number;
}

export class Presence {
  private readonly entries = new Map<string, Entry>();
  readonly bootedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.bootedAt = now();
  }

  /** A row's key: one per computer and fleet (a device can be listed in several orgs). */
  static key(orgId: string | null, deviceId: string): string {
    return `${orgId ?? "account"}|${deviceId}`;
  }

  /** This presence's clock (a test moves it). */
  clock(): number {
    return this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /** The remembered checks for this caller, if they are still trusted and are exactly this caller. */
  trusted(key: string, who: { userId: string; deviceId: string | null; tokenId: string }): Identity | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.validatedAt >= IDENTITY_MS) return null;
    const i = e.identity;
    return i.userId === who.userId && i.deviceId === who.deviceId && i.tokenId === who.tokenId ? i : null;
  }

  /** Is a database write due for this beat: the computer was not online, or the stored time is an hour old. */
  writeDue(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return true;
    const t = this.now();
    return t - e.lastBeat >= LEASE_MS || t - e.lastDbWrite >= DB_WRITE_MS;
  }

  /**
   * A beat (or a publish) landed. `validated` when the full checks just ran (the identity is
   * remembered afresh); `wrote` when the database row's seen_at was just written.
   */
  beat(key: string, orgId: string | null, identity: Identity, opts: { validated: boolean; wrote: boolean }): void {
    const t = this.now();
    const e = this.entries.get(key);
    if (e && e.identity.tokenId === identity.tokenId && e.identity.keyId === identity.keyId && e.identity.userId === identity.userId) {
      e.lastBeat = t;
      if (opts.wrote) e.lastDbWrite = t;
      if (opts.validated) e.validatedAt = t;
      return;
    }
    if (this.entries.size >= MAX_ENTRIES) this.sweep();
    this.entries.set(key, { orgId, identity, validatedAt: t, lastBeat: t, lastDbWrite: opts.wrote ? t : 0 });
  }

  /** Whether a lease is live right now. */
  leased(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && this.now() - e.lastBeat < LEASE_MS;
  }

  /** The last beat this process saw, if any. */
  lastBeat(key: string): number | null {
    return this.entries.get(key)?.lastBeat ?? null;
  }

  /**
   * What the list says: online on a live lease, or (the first BOOT_WINDOW_MS after a start)
   * on a stored seen_at from the last DB_WRITE_MS. `seenAt` and `expiresAt` keep the old wire
   * meaning (the lease is 90 s from the last beat).
   */
  state(key: string, storedSeenAt: Date): { online: boolean; seenAt: Date; expiresAt: Date } {
    const t = this.now();
    const beat = this.lastBeat(key);
    const stored = storedSeenAt.getTime();
    if (beat !== null && t - beat < LEASE_MS) return { online: true, seenAt: new Date(beat), expiresAt: new Date(beat + LEASE_MS) };
    const seen = beat !== null && beat > stored ? beat : stored;
    // In the boot window `online` is a guess from the stored time, so `expiresAt` (90 s after it) can already be past; no client reads it to decide online.
    const booting = t - this.bootedAt < BOOT_WINDOW_MS && t - stored < DB_WRITE_MS;
    return { online: booting, seenAt: new Date(seen), expiresAt: new Date(seen + LEASE_MS) };
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  /** Drop everything about a computer, whichever fleet lists it (device revoked, sync deleted). */
  forgetDevice(deviceId: string): void {
    for (const [k, e] of this.entries) if (e.identity.deviceId === deviceId) this.entries.delete(k);
  }

  /** Drop everything about an account's computers (key rotated, sync deleted, account deleted). Entries are few and these calls rare, so it scans. */
  forgetUser(userId: string): void {
    for (const [k, e] of this.entries) if (e.identity.userId === userId) this.entries.delete(k);
  }

  /** Drop an org's entries (org key rotated, org deleted). */
  forgetOrg(orgId: string): void {
    for (const [k, e] of this.entries) if (e.orgId === orgId) this.entries.delete(k);
  }

  /** Drop one member's entries in an org (removed or left). */
  forgetMember(orgId: string, userId: string): void {
    for (const [k, e] of this.entries) if (e.orgId === orgId && e.identity.userId === userId) this.entries.delete(k);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.lastBeat >= DB_WRITE_MS) this.entries.delete(k);
    // Still full: every one is live. Refuse to grow; the oldest go first.
    while (this.entries.size >= MAX_ENTRIES) {
      const first = this.entries.keys().next();
      if (first.done) break;
      this.entries.delete(first.value);
    }
  }
}

declare module "fastify" {
  interface FastifyInstance {
    presence: Presence;
  }
}

/** One Presence per server, shared by the fleet, org and sync routes so a change in one drops what another remembered. */
export function registerPresence(app: FastifyInstance, presence: Presence = new Presence()): Presence {
  app.decorate("presence", presence);
  return presence;
}
