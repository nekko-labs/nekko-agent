import type { SessionSummary } from '@nekko-agent/shared';
import type { Workspace } from '../store.js';

/** Chats without a sidebar row remain available, even if open in a split pane. */
export function unopenedChats(sessions: SessionSummary[], workspaces: Workspace[], visibleChildIds: ReadonlySet<string> = new Set()): SessionSummary[] {
  // The sidebar renders workspace anchors, not every pane in their split tree.
  const anchorIds = new Set(workspaces.filter((w) => w.anchor.kind === 'chat').map((w) => w.anchor.refId));
  return sessions.filter((s) => !s.archivedAt && !anchorIds.has(s.id) && !visibleChildIds.has(s.id));

}

/** Opening a nested child changes its transcript, not its sidebar identity. */
export function sidebarWorkspaces(workspaces: Workspace[], visibleChildIds: ReadonlySet<string>): Workspace[] {
  return workspaces.filter((w) => w.anchor.kind !== 'chat' || !visibleChildIds.has(w.anchor.refId));
}

/**
 * Which of a chat's sub-agents get a row under its card. One that is working
 * always does. A finished one does while the chat is working or open, so you
 * can see how the work was split; otherwise the card's count stands in for it.
 */
export function subagentRows<T extends { id: string }>(kids: T[], working: (id: string) => boolean, parentId: string, selectedId?: string | null): T[] {
  const inFocus = working(parentId) || parentId === selectedId || kids.some((kid) => kid.id === selectedId);
  return inFocus ? kids : kids.filter((kid) => working(kid.id));
}
