import type { SessionSummary, WallLayout, WallLayoutMode } from '@nekko-agent/shared';

/**
 * An emptied Agents wall opens the Focused new-chat screen instead of the
 * "The wall is empty" placeholder. This picks the chat it shows: the newest
 * top-level chat that was never used (no messages, nothing queued, not
 * completed, not an automation or training run), so emptying the wall again
 * does not pile up blank chats. `null` means a fresh chat is needed.
 */
export function reusableEmptyChat(sessions: SessionSummary[]): string | null {
  let pick: SessionSummary | null = null;
  for (const s of sessions) {
    if (s.messageCount > 0 || s.parentSessionId || s.taskId || s.trainingRunId || s.archivedAt) continue;
    if (s.chatType === 'image') continue;
    if (s.queue?.length) continue;
    if (!pick || s.createdAt > pick.createdAt) pick = s;
  }
  return pick?.id ?? null;
}

/**
 * Whether this wall should open the new-chat screen now. Only once the
 * session lists have loaded (the empty lists a view mounts with are not an
 * empty wall), only with a usable provider (otherwise the empty state's setup
 * path applies), and not while a completed chat is being read. A second
 * window (another screen or desktop) opens on its new-chat screen too.
 */
export function shouldStartFromEmptyWall(opts: {
  listsReady: boolean;
  hasWindows: boolean;
  readingCompleted: boolean;
  providerReady: boolean;
}): boolean {
  return opts.listsReady && !opts.hasWindows && !opts.readingCompleted && opts.providerReady;
}

/**
 * A newly opened second window's layout: the mode of the window that opened
 * it, and in Dynamic the default two panes side by side rather than the
 * opener's grid size.
 */
export function newScreenLayout(layout: WallLayout, mode: WallLayoutMode): WallLayout {
  return { ...layout, mode, cols: 2, rows: 1, fixedGrid: false };
}
