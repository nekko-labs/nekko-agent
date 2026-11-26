import React, { useRef, useState } from 'react';
import type { WorkspaceFolder } from '@nekko-agent/shared';
import { DirTree } from '../components/FileTree.js';
import { FileTypeIcon } from '../fileIcons.js';
import { ChevronIcon, PlusIcon } from '../icons.js';
import { FolderOpenIcon, GfCloseIcon } from '../gentleface-icons.js';
import { useStore } from '../store.js';

/** A path's last segment: what a file row is called. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/** The connected folder a file sits in (the deepest one, so a repository wins over the folder around it). */
export function folderOfFile(path: string, folders: readonly WorkspaceFolder[]): WorkspaceFolder | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const file = norm(path);
  return folders
    .filter((f) => file.startsWith(norm(f.path) + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * The Agents panel's Files view: a file browser. The files open in the wall's
 * windows come first, then every folder connected on this computer as a tree
 * to browse. Picking a file opens it, editable, in a window of its own.
 */
export function SidebarFileBrowser({ folders, openFiles, activeFile, onOpenFile }: {
  folders: readonly WorkspaceFolder[];
  /** Files open in the agent windows, in the order they appear. */
  openFiles: readonly string[];
  /** The file whose window is the active one, if any. */
  activeFile?: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const addButton = useRef<HTMLButtonElement>(null);
  const changing = useRef(false);
  const [busy, setBusy] = useState(false);
  async function changeFolders(action: string, change: () => Promise<void>) {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    try {
      await change();
    } catch (error) {
      useStore.getState().pushToast('error', `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }
  const add = () => changeFolders('add folder', async () => {
    const path = await window.nekko.pickFolder();
    if (!path) return;
    await window.nekko.addWorkspaceByPath(path);
    await useStore.getState().refreshSettings(false);
  });
  const disconnect = (folder: WorkspaceFolder, button: HTMLButtonElement) => changeFolders('disconnect folder', async () => {
    await window.nekko.removeWorkspace(folder.id);
    const store = useStore.getState();
    if (store.activeProjectId === folder.id) store.setActiveProject(null);
    // Restore keyboard focus before the focused row leaves, without stealing it from another control.
    if (document.activeElement === button) addButton.current?.focus({ preventScroll: true });
    setExpanded((prev) => new Set([...prev].filter((id) => id !== folder.id)));
    await store.refreshSettings(false);
    await store.refreshSessions();
  });
  const folderAction = 'btn btn-ghost aria-disabled:cursor-wait aria-disabled:opacity-50 motion-reduce:transition-none';

  return (
    <div data-file-browser>
      {openFiles.length > 0 && <>
        <p className="px-2 pb-1 pt-1 text-2xs font-semibold text-ink-faint" data-open-files-heading>Open</p>
        {openFiles.map((path) => {
          const active = path === activeFile;
          const folder = folderOfFile(path, folders);
          return (
            <button key={path} type="button" data-open-file={path}
              aria-current={active || undefined}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${active ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
              title={path}
              onClick={() => onOpenFile(path)}>
              <FileTypeIcon name={baseName(path)} size={16} />
              <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{baseName(path)}</span>
              {folder && <span className="max-w-[40%] shrink-0 truncate text-2xs text-ink-faint" dir="auto">{folder.name}</span>}
            </button>
          );
        })}
        <p className="px-2 pb-1 pt-4 text-2xs font-semibold text-ink-faint" data-folders-heading>Folders</p>
      </>}
      {folders.map((f) => {
        const open = expanded.has(f.id);
        return (
          <div key={f.id}>
            <div className="flex items-center">
              <button type="button" data-connected-folder={f.id}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2"
                title={f.path}
                onClick={() => toggle(f.id)}>
                <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                <FolderOpenIcon className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{f.name}</span>
                {f.repo && <span className="max-w-[45%] shrink-0 truncate text-2xs text-ink-faint" dir="auto">{f.repo.fullName}</span>}
              </button>
              <button type="button" aria-label={`Disconnect ${f.name}`}
                title="Disconnect from Nekko and its chats. Files stay on disk."
                aria-disabled={busy || undefined}
                className={`${folderAction} h-7 w-7 px-0`}
                onClick={(event) => void disconnect(f, event.currentTarget)}>
                <GfCloseIcon className="h-4 w-4" />
              </button>
            </div>
            {open && <div className="pb-1 pl-3" data-folder-tree={f.id}><DirTree root={f.path} onOpen={onOpenFile} /></div>}
          </div>
        );
      })}
      {folders.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-faint" data-agent-panel-empty>No folders connected</p>}
      <button ref={addButton} type="button" aria-disabled={busy || undefined}
        className={`${folderAction} mt-2 w-full justify-start px-2`} onClick={() => void add()}>
        <PlusIcon className="h-4 w-4" /> Add folder…
      </button>
    </div>
  );
}
