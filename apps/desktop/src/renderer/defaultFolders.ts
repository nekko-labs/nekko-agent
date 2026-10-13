import { useStore } from './store.js';

/**
 * The starred default folders a new chat starts with (the first is primary).
 * Starring appends a folder, unstarring removes it; ids of folders that no
 * longer exist are dropped on the way.
 */
export function nextDefaultFolders(saved: string[] | undefined, id: string, folders: { id: string }[]): string[] {
  const current = (saved ?? []).filter((x, i, all) => all.indexOf(x) === i && folders.some((f) => f.id === x));
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/** Star or unstar a folder as a default for new chats, and persist it. */
export function toggleDefaultFolder(id: string): void {
  const settings = useStore.getState().settings;
  const next = nextDefaultFolders(settings?.defaultWorkspaceIds, id, settings?.workspaces ?? []);
  void window.nekko.updateSettings({ defaultWorkspaceIds: next })
    .then(() => useStore.getState().refreshSettings())
    .catch((e) => useStore.getState().pushToast('error', String(e)));
}
