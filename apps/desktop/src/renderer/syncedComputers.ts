import { computerIdOf, syncedComputerColor, type ChatHome, type ComputerState, type ComputerStatus, type SessionSummary } from '@nekko-agent/shared';

/**
 * Other computers' chats, synced here through Nekko Cloud (#3143, decision 0112).
 * Each chat belongs to the computer it started on; a copy here names that
 * computer in `home` and is read-only. The Agents panel labels and groups them
 * like a connected computer's chats.
 */

/** What a computer chip or group heading needs: a connected computer, or a synced one. */
export interface ChipComputer {
  id: string;
  name: string;
  color: number;
  icon?: string;
  /** Only a connected computer has a live state; a synced one is a copy, with none. */
  state?: ComputerState;
}

const NONE: ChatHome[] = [];
const homesOf = new WeakMap<readonly SessionSummary[], ChatHome[]>();

/** The other computers the chats here belong to, once each, in the order the list first names them. */
export function syncedHomes(sessions: readonly SessionSummary[] | undefined): ChatHome[] {
  if (!sessions) return NONE;
  const cached = homesOf.get(sessions);
  if (cached) return cached;
  const seen = new Map<string, ChatHome>();
  for (const s of sessions) {
    const id = s.home?.deviceId;
    if (id && !seen.has(id)) seen.set(id, s.home!);
  }
  const homes = [...seen.values()];
  homesOf.set(sessions, homes);
  return homes;
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The connected computer a synced computer is, by name, when one is connected: it lends its colour, icon and state. */
export function connectedTwin(home: ChatHome, computers: readonly ComputerStatus[]): ComputerStatus | null {
  return computers.find((c) => sameName(c.name, home.device)) ?? null;
}

/** A synced chat's computer as its chip and group show it. */
export function syncedComputer(home: ChatHome, computers: readonly ComputerStatus[]): ChipComputer {
  const twin = connectedTwin(home, computers);
  if (twin) return twin;
  return { id: 'cloud:' + home.deviceId, name: home.device.trim() || 'Another computer', color: syncedComputerColor(home.deviceId) };
}

const visibleOf = new WeakMap<readonly SessionSummary[], SessionSummary[]>();

/**
 * The list without synced copies the same computer also shows live: a chat of a
 * connected computer arrives both ways, and the live one (which can take a
 * message) is the one listed.
 */
export function withoutShadowedCopies(sessions: readonly SessionSummary[]): SessionSummary[] {
  const cached = visibleOf.get(sessions);
  if (cached) return cached;
  let out = sessions as SessionSummary[];
  if (sessions.some((s) => s.home)) {
    const live = new Set<string>();
    for (const s of sessions) {
      const cid = computerIdOf(s.id);
      if (cid) live.add(s.id.slice(cid.length + 2));
    }
    if (live.size > 0) {
      const kept = sessions.filter((s) => !(s.home && live.has(s.id)));
      if (kept.length !== sessions.length) out = kept;
    }
  }
  visibleOf.set(sessions, out);
  return out;
}

/** What a read-only copy says where its composer would be. */
export function syncedBlock(home: ChatHome): string {
  return `From ${home.device.trim() || 'another computer'}, through Nekko Cloud. Read-only here`;
}
