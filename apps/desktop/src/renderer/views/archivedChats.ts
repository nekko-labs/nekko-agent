import type { SessionSummary } from '@nekko-agent/shared';

/**
 * An archived chat's date as its sidebar row shows it: "Dec 20" within the
 * current year, "Dec 15, 2025" for an earlier one.
 */
export function archivedDate(at: number, now: number = Date.now(), locale?: string): string {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/**
 * Archived top-level chats for one sidebar group, most recently archived first.
 * `groupOf` maps a chat to its group key (its project, or the General bucket).
 */
export function archivedInGroup(
  sessions: SessionSummary[],
  key: string,
  groupOf: (s: SessionSummary) => string,
): SessionSummary[] {
  const ids = new Set(sessions.map((s) => s.id));
  return sessions
    .filter((s) => !!s.archivedAt && groupOf(s) === key && (!s.parentSessionId || !ids.has(s.parentSessionId)))
    .sort((a, b) => (b.archivedAt as number) - (a.archivedAt as number));
}
