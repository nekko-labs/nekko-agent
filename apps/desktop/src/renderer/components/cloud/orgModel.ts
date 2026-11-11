import { cloudError, type CloudStatus, type FleetList, type FleetModel, type NekkoApi, type Org, type OrgDetail, type OrgList, type OrgRole, type OrgSummary } from '@nekko-agent/shared';

/** How often the Computers list is refreshed while the Organization section is on screen. */
export const FLEET_POLL_MS = 15_000;
/** Local models shown on a computer before the rest fold behind "+N more". */
export const MODELS_SHOWN = 3;

export type OrgGate = 'signed-out' | 'needs-plan' | 'needs-setup' | 'locked' | 'ready';

/**
 * Whether this computer can use organizations: signed in, on a plan that has
 * Nekko Cloud sync, and holding the account's key (the same unlock as sync:
 * the recovery key, or approval from another device).
 */
export function orgGate(status: CloudStatus | null): OrgGate {
  if (!status?.signedIn) return 'signed-out';
  const phase = status.sync.phase;
  if (phase === 'signed-out') return 'signed-out';
  if (phase === 'needs-plan') return 'needs-plan';
  // Sync was never turned on, so this account has no key on any device yet.
  if (phase === 'off') return 'needs-setup';
  if (phase === 'idle' || phase === 'syncing' || phase === 'paused' || phase === 'error') return 'ready';
  // needs-join or awaiting-approval: the account has keys, this computer does not.
  return 'locked';
}

const UNKNOWN_CHANNEL = /unknown (channel|command|method)|no such channel|no handler|not implemented|channel-denied|unsupported channel|404/i;

/**
 * Plain text for a failed organization call. A daemon that does not know the
 * channel yet (an older engine) is a quiet "not available", not a crash.
 */
export function orgErrorText(e: unknown): string {
  const raw = cloudError(e);
  if (UNKNOWN_CHANNEL.test(raw)) return 'Organizations are not available in this version of Nekko Agent yet. Update the app and try again.';
  if (/orgs-not-available/.test(raw)) return 'Organizations are not available for your account yet.';
  if (/plan-required/.test(raw)) return 'Creating an organization needs Nekko Cloud Pro or Team.';
  if (/last-owner/.test(raw)) return 'An organization needs at least one owner.';
  if (/needs-synced-device/.test(raw)) return 'Unlock your account on this computer to see this organization\'s computers.';
  return raw || 'Something went wrong. Try again.';
}

export const canManage = (role: OrgRole | undefined) => role === 'owner' || role === 'admin';

export function roleLabel(role: OrgRole): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
}

/** "an owner", "an admin", "a member". */
export const roleSentence = (role: OrgRole) => `${role === 'member' ? 'a' : 'an'} ${role}`;

/** Which of several organizations to show: the one asked for, else the first. */
export function pickOrg<T extends Pick<Org, 'id'>>(orgs: T[], wanted: string | null): T | null {
  return orgs.find((o) => o.id === wanted) ?? orgs[0] ?? null;
}

export function osLabel(os: string): string {
  return os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : os;
}

/** "Last seen 5 min ago" from a timestamp the engine gives as epoch milliseconds or an RFC 3339 string. */
export function lastSeen(seenAt: number | string | null, now = Date.now()): string {
  const ms = typeof seenAt === 'string' ? Date.parse(seenAt) : seenAt;
  if (ms == null || Number.isNaN(ms)) return 'Offline';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'Last seen just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Last seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last seen ${h} h ago`;
  const d = Math.round(h / 24);
  return d < 8 ? `Last seen ${d} d ago` : `Last seen ${new Date(ms).toLocaleDateString()}`;
}

/** The first few local model names, and how many are folded away. */
export function splitModels(models: FleetModel[], expanded: boolean): { shown: FleetModel[]; hidden: number } {
  if (expanded || models.length <= MODELS_SHOWN) return { shown: models, hidden: 0 };
  return { shown: models.slice(0, MODELS_SHOWN), hidden: models.length - MODELS_SHOWN };
}

/** Computers with this one first, then online, then by name. */
export function sortComputers<T extends { you: boolean; online: boolean; name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.you) - Number(a.you) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** The slice of `window.nekko` the section uses, so tests can hand in a fake. */
export type OrgApi = Pick<NekkoApi, 'orgList' | 'orgGet' | 'fleetList' | 'fleetSetSharing'>;

export interface OrgSnapshot {
  list: OrgList;
  detail: OrgDetail | null;
  fleet: FleetList | null;
  /** Plain text when only the Computers list could not be loaded. */
  fleetError: string;
}

/**
 * Everything the section shows: your organizations and invites, the selected
 * organization's members, and its computers. A failed Computers call keeps the
 * rest on screen.
 */
export async function loadOrgs(api: OrgApi, wanted: string | null): Promise<OrgSnapshot> {
  const list = await api.orgList();
  const org = pickOrg(list.orgs, wanted);
  if (!org) return { list, detail: null, fleet: null, fleetError: '' };
  const detail = await api.orgGet(org.id);
  const fleet = await loadFleet(api, detail);
  return { list, detail, fleet: fleet.fleet, fleetError: fleet.error };
}

/** The Computers list for an organization; nothing to ask while this device lacks the key. */
export async function loadFleet(api: OrgApi, org: Pick<OrgSummary, 'id' | 'hasKey'>): Promise<{ fleet: FleetList | null; error: string }> {
  if (!org.hasKey) return { fleet: null, error: '' };
  try {
    const fleet = await api.fleetList(org.id);
    return { fleet, error: fleet.error ?? '' };
  } catch (e) {
    return { fleet: null, error: orgErrorText(e) };
  }
}

/** Turns sharing on or off for one organization; the answer says what the engine did. */
export async function setSharing(api: OrgApi, orgId: string, on: boolean): Promise<boolean> {
  const r = await api.fleetSetSharing(orgId, on);
  return r.sharing;
}
