/**
 * Archived chats: out of the workspace list, still on disk until restored or
 * explicitly deleted. Compatibility helpers remain for callers that used to
 * show the retired expiry window, but completed history no longer expires.
 */

/** Archived chats are retained indefinitely. */
export const ARCHIVE_RETENTION_DAYS = Number.POSITIVE_INFINITY;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a chat (or its summary) is archived. */
export function isArchived(s: { archivedAt?: number | null }): boolean {
  return typeof s.archivedAt === 'number' && s.archivedAt > 0;
}

/** When an archived chat is due to be deleted (epoch ms). */
export function archiveDeletesAt(archivedAt: number): number {
  return archivedAt + ARCHIVE_RETENTION_DAYS * DAY_MS;
}

/**
 * Whole days left before an archived chat is deleted, rounded up so a chat
 * with hours left still says "1 day" rather than "0", and never negative.
 */
export function archiveDaysLeft(archivedAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((archiveDeletesAt(archivedAt) - now) / DAY_MS));
}

/**
 * How long an agent may sit untouched before it is completed for you. Days, or
 * `0` for never. Completing is the same reversible archive the X does.
 */
export const AUTO_COMPLETE_CHOICES = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 0, label: 'Never' },
] as const;
export const AUTO_COMPLETE_DEFAULT_DAYS = 30;

/** The configured idle window in days; anything unrecognised falls back to the default. */
export function autoCompleteDays(setting: unknown): number {
  return AUTO_COMPLETE_CHOICES.some((c) => c.days === setting) ? (setting as number) : AUTO_COMPLETE_DEFAULT_DAYS;
}

/** What auto-completion needs to know about an agent. */
export interface AutoCompleteCandidate {
  id: string;
  updatedAt: number;
  archivedAt?: number | null;
  pinned?: boolean;
  parentSessionId?: string;
  taskId?: string;
  trainingRunId?: string;
}

/**
 * Agents idle longer than `days` that nobody is relying on: not pinned, not a
 * sub-agent (it goes with its parent), not driven by a task or training run,
 * not running and not waiting for an answer.
 */
export function agentsToAutoComplete(
  sessions: AutoCompleteCandidate[],
  days: number,
  now: number,
  busy: (id: string) => boolean = () => false,
): string[] {
  if (!days) return [];
  const cutoff = now - days * DAY_MS;
  return sessions
    .filter((s) => !isArchived(s) && !s.pinned && !s.parentSessionId && !s.taskId && !s.trainingRunId)
    .filter((s) => typeof s.updatedAt === 'number' && s.updatedAt > 0 && s.updatedAt < cutoff && !busy(s.id))
    .map((s) => s.id);
}

/** Compatibility helper: completed history never expires automatically. */
export function archiveExpired(_s: { archivedAt?: number | null }, _now = Date.now()): boolean {
  return false;
}
