import { REPO_PROVIDERS, sameFolderPath, type ConnectorConfig, type RemoteRepo, type Session, type SessionMeta, type WorkspaceFolder } from '@nekko-agent/shared';
import { LAST_FOLDER_KEY, useStore } from './store.js';

/**
 * Which folders a chat is wired into: one primary (the agent's working
 * directory) plus supporting folders that index search and memory also span.
 * Shared by the Context Inspector's Folders section and the composer's folder
 * picker so both follow the same rules.
 */
export interface FolderSelection {
  primary: string | undefined;
  supporting: string[];
}

type ChatFolders = Pick<SessionMeta, 'workspaceId' | 'supportingWorkspaceIds'> | null | undefined;

/** Make `id` primary; the old primary stays in the chat as supporting. */
export function withPrimary(session: ChatFolders, id: string): FolderSelection {
  return {
    primary: id,
    supporting: [
      ...(session?.workspaceId && session.workspaceId !== id ? [session.workspaceId] : []),
      ...(session?.supportingWorkspaceIds ?? []).filter((wid) => wid !== id),
    ],
  };
}

/** Clear the primary; like a switch, the old primary stays as supporting. */
export function withoutPrimary(session: ChatFolders): FolderSelection {
  return {
    primary: undefined,
    supporting: [...(session?.workspaceId ? [session.workspaceId] : []), ...(session?.supportingWorkspaceIds ?? [])],
  };
}

/** Wire `id` in: primary when the chat has none, otherwise supporting. */
export function withIncluded(session: ChatFolders, id: string): FolderSelection {
  const supporting = session?.supportingWorkspaceIds ?? [];
  if (!session?.workspaceId) return { primary: id, supporting: supporting.filter((wid) => wid !== id) };
  if (session.workspaceId === id || supporting.includes(id)) return { primary: session.workspaceId, supporting };
  return { primary: session.workspaceId, supporting: [...supporting, id] };
}

/** Unwire `id`; dropping the primary promotes the first supporting folder. */
export function withExcluded(session: ChatFolders, id: string): FolderSelection {
  const supporting = session?.supportingWorkspaceIds ?? [];
  if (session?.workspaceId === id) {
    const [primary, ...rest] = supporting;
    return { primary, supporting: rest };
  }
  return { primary: session?.workspaceId, supporting: supporting.filter((wid) => wid !== id) };
}

/**
 * Whether sending now should auto-file the chat under a detected project: only
 * its first prompt, and only while it has no folders at all. Clearing the
 * primary keeps it as supporting, so a cleared chat stays unfiled.
 */
export function shouldAutoFile(chat: Pick<Session, 'messages'> | null, folders: ChatFolders): boolean {
  try { if (localStorage.getItem(LAST_FOLDER_KEY) === 'null') return false; } catch { /* private mode */ }
  if (!chat || chat.messages.some((m) => m.role === 'user')) return false;
  return !folders?.workspaceId && !folders?.supportingWorkspaceIds?.length;
}

/**
 * Persist a selection. Both calls are needed: setting the primary drops it from
 * supporting but never demotes the old primary.
 */
export async function applyFolderSelection(sessionId: string, sel: FolderSelection): Promise<Session | null> {
  await window.nekko.setSessionWorkspace(sessionId, sel.primary);
  const updated = await window.nekko.setSessionSupportingWorkspaces(sessionId, sel.supporting);
  if (updated) useStore.getState().setActiveProject(sel.primary ?? null);
  await useStore.getState().refreshSessions();
  return updated;
}

/**
 * Pick a folder and wire it into the chat. Returns the updated chat, or null
 * when the picker was cancelled. A folder already registered is reused.
 */
export async function addFolderToChat(
  sessionId: string,
  session: ChatFolders,
  mode: 'primary' | 'include',
): Promise<Session | null> {
  const path = await window.nekko.pickFolder();
  if (!path) return null;

  const folders = await window.nekko.addWorkspaceByPath(path);
  const folder = folders.find((w) => sameFolderPath(w.path, path));
  if (!folder) return null;
  await useStore.getState().refreshSettings();

  return applyFolderSelection(sessionId, mode === 'primary' ? withPrimary(session, folder.id) : withIncluded(session, folder.id));
}

/** Wire an already-known folder path (one the agent found) into the chat. */
export async function addFolderPathToChat(sessionId: string, session: ChatFolders, path: string): Promise<{ session: Session | null; folder: WorkspaceFolder | null }> {
  const folders = await window.nekko.addWorkspaceByPath(path);
  const folder = folders.find((w) => sameFolderPath(w.path, path)) ?? null;
  if (!folder) return { session: null, folder: null };
  await useStore.getState().refreshSettings();
  return { session: await applyFolderSelection(sessionId, withIncluded(session, folder.id)), folder };
}

/** Whether a GitHub or GitLab connector is connected, so repositories can be listed. */
export function hasRepoProvider(connectors: ConnectorConfig[] | undefined): boolean {
  return (connectors ?? []).some((c) => c.connected && (REPO_PROVIDERS as string[]).includes(c.kind));
}

/**
 * Clone a repository (or reuse its existing clone) and wire it into the chat:
 * primary when the chat has none, otherwise supporting.
 */
export async function addRepoToChat(
  sessionId: string,
  session: ChatFolders,
  repo: Pick<RemoteRepo, 'provider' | 'fullName' | 'cloneUrl' | 'webUrl'>,
): Promise<{ session: Session | null; path: string }> {
  const result = await window.nekko.cloneRepo({ provider: repo.provider, fullName: repo.fullName, cloneUrl: repo.cloneUrl, webUrl: repo.webUrl });
  await useStore.getState().refreshSettings();
  if (!result.folderId) return { session: null, path: result.path };
  return { session: await applyFolderSelection(sessionId, withIncluded(session, result.folderId)), path: result.path };
}
