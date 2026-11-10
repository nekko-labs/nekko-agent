import type { Session, SessionMeta } from '@nekko-agent/shared';
import type { QuestionActions } from './components/QuestionCard.js';
import { addFolderPathToChat, addFolderToChat, addRepoToChat } from './sessionFolders.js';
import { useStore } from './store.js';

type ChatFolders = Pick<SessionMeta, 'workspaceId' | 'supportingWorkspaceIds'> | null | undefined;

/**
 * What the agent's question card does for an option's environment action
 * (#2404): each one widens the chat's environment and returns the line the
 * agent reads with the answer, naming what was added and where.
 */
export function environmentActions(sessionId: string, chat: () => ChatFolders, onSession: (s: Session) => void): QuestionActions {
  const added = (what: string, path: string) => `(Added ${what} to this chat's environment at ${path}. Work there by its full path.)`;
  return {
    run: async (action) => {
      if (action.kind === 'pickFolder') {
        const s = await addFolderToChat(sessionId, chat(), 'include');
        if (!s) return null;
        onSession(s);
        const ids = [s.workspaceId, ...(s.supportingWorkspaceIds ?? [])];
        const folders = useStore.getState().settings?.workspaces ?? [];
        // The folder just added is the last one wired in.
        const folder = [...ids].reverse().map((id) => folders.find((f) => f.id === id)).find(Boolean);
        return folder ? added(`the folder ${folder.name}`, folder.path) : '(Added the chosen folder to this chat\'s environment.)';
      }
      const { session: s, folder } = await addFolderPathToChat(sessionId, chat(), action.path);
      if (!folder) throw new Error(`Couldn't add ${action.path}: it isn't a folder this app can open.`);
      if (s) onSession(s);
      return added(`the folder ${folder.name}`, folder.path);
    },
    addRepo: async (repo) => {
      const { session: s, path } = await addRepoToChat(sessionId, chat(), repo);
      if (s) onSession(s);
      return added(`the repository ${repo.fullName}`, path);
    },
    connect: () => useStore.getState().setView('connectors'),
  };
}
