import type { Workspace } from './store.js';
import { allPanes, isSplit, type WbNode } from './layout.js';
import { wallStorageKey } from './displays.js';

/**
 * The open workspaces, kept across restarts.
 *
 * Workspaces used to live only in memory, so every relaunch started with an
 * empty sidebar and the chats you had open seemed to have gone. The chats were
 * on disk the whole time; what was lost was the arrangement that pointed at
 * them. Parking that arrangement here (it is small: ids and split sizes, no
 * transcripts) means relaunching puts you back where you were.
 *
 * A saved layout can outlive what it points at (a chat archived or deleted
 * from another client, a terminal that ended with the last session), so it is
 * pruned against what still exists once the session and terminal lists load.
 */

// A second screen's window keeps its own arrangement (multi-monitor), so the
// two windows sharing this storage never overwrite each other's panes.
const KEY = wallStorageKey('nekko.workspaces.v1');

export interface SavedLayout {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

function validNode(n: unknown): n is WbNode {
  if (!n || typeof n !== 'object') return false;
  const o = n as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (Array.isArray(o.children)) {
    return (o.dir === 'row' || o.dir === 'col') && Array.isArray(o.sizes) && o.children.every(validNode);
  }
  return typeof o.kind === 'string' && typeof o.refId === 'string';
}

function validWorkspace(w: unknown): w is Workspace {
  if (!w || typeof w !== 'object') return false;
  const o = w as Record<string, unknown>;
  const anchor = o.anchor as Record<string, unknown> | undefined;
  return (
    typeof o.id === 'string' &&
    !!anchor && typeof anchor.kind === 'string' && typeof anchor.refId === 'string' &&
    (o.root === null || validNode(o.root))
  );
}

/** The saved layout, or an empty one when there is none (or it is unreadable). */
export function loadLayout(store: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): SavedLayout {
  try {
    const parsed = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<SavedLayout> | null;
    const workspaces = Array.isArray(parsed?.workspaces) ? parsed!.workspaces.filter(validWorkspace) : [];
    const activeWorkspaceId = typeof parsed?.activeWorkspaceId === 'string' && workspaces.some((w) => w.id === parsed.activeWorkspaceId)
      ? parsed.activeWorkspaceId
      : workspaces[workspaces.length - 1]?.id ?? null;
    return { workspaces, activeWorkspaceId };
  } catch {
    return { workspaces: [], activeWorkspaceId: null };
  }
}

export function saveLayout(layout: SavedLayout, store: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    store?.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* private mode or quota: the layout is a convenience, never worth an error */
  }
}

/**
 * The highest numeric suffix used by any id in the saved layout, so freshly
 * minted pane, split and workspace ids continue past it rather than colliding
 * with ids restored from disk (the counters restart at zero every launch).
 */
export function maxIdSeq(workspaces: Workspace[]): number {
  let max = 0;
  const see = (id: string) => {
    const m = /_([0-9a-z]+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 36) || 0);
  };
  const walk = (n: WbNode) => {
    see(n.id);
    if (isSplit(n)) n.children.forEach(walk);
  };
  for (const w of workspaces) {
    see(w.id);
    if (w.root) walk(w.root);
  }
  return max;
}

/**
 * Drop windows whose chat or terminal no longer exists, and workspaces left
 * with nothing. Chats are checked against the live (non-archived) list;
 * terminals only once their list has loaded (`terminalIds` null = unknown), so
 * an early prune can never throw away a shell that simply has not been listed
 * yet. Everything else (files, browsers, PRs) is kept as it was.
 */
export function pruneLayout(
  workspaces: Workspace[],
  liveChatIds: Set<string>,
  terminalIds: Set<string> | null,
  removePane: (root: WbNode | null, paneId: string) => WbNode | null,
): Workspace[] {
  const dead = (kind: string, refId: string) =>
    (kind === 'chat' || kind === 'diff') ? !liveChatIds.has(refId)
      : kind === 'terminal' ? terminalIds !== null && !terminalIds.has(refId)
      : false;
  const out: Workspace[] = [];
  for (const w of workspaces) {
    // A workspace whose anchor chat is gone has lost its identity; drop it
    // rather than keep a card describing nothing.
    if (dead(w.anchor.kind, w.anchor.refId)) continue;
    const doomed = allPanes(w.root).filter((p) => dead(p.kind, p.refId));
    // Untouched workspaces keep their identity, so callers can tell nothing changed.
    if (doomed.length === 0) { out.push(w); continue; }
    let root = w.root;
    for (const p of doomed) root = removePane(root, p.id);
    if (!root) continue;
    const panes = allPanes(root);
    out.push({
      ...w,
      root,
      activePaneId: panes.some((p) => p.id === w.activePaneId) ? w.activePaneId : panes[0]?.id ?? null,
    });
  }
  return out;
}
