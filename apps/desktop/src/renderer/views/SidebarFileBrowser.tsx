import React, { useState } from 'react';
import type { WorkspaceFolder } from '@nekko-agent/shared';
import { DirTree } from '../components/FileTree.js';
import { FileTypeIcon } from '../fileIcons.js';
import { ChevronIcon } from '../icons.js';
import { FolderOpenIcon } from '../gentleface-icons.js';

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
            <button type="button" data-connected-folder={f.id}
              aria-expanded={open}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2"
              title={f.path}
              onClick={() => toggle(f.id)}>
              <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
              <FolderOpenIcon className="h-4 w-4 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{f.name}</span>
              {f.repo && <span className="max-w-[45%] shrink-0 truncate text-2xs text-ink-faint" dir="auto">{f.repo.fullName}</span>}
            </button>
            {open && <div className="pb-1 pl-3" data-folder-tree={f.id}><DirTree root={f.path} onOpen={onOpenFile} /></div>}
          </div>
        );
      })}
      {folders.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-faint" data-agent-panel-empty>No folders connected</p>}
    </div>
  );
}
