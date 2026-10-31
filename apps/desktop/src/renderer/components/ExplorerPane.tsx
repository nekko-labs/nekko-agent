import React from 'react';
import { useStore } from '../store.js';
import { DirTree } from './FileTree.js';
import { FolderIcon } from '../icons.js';

/**
 * A file explorer as a window of its own, rooted at one folder.
 *
 * The context panel on the right has always carried a tree, but it is the app's
 * tree — one, on the far side of the window, following the active chat. A
 * workspace that is about a folder wants the folder next to the work, and a
 * workspace can hold several of these rooted at different places. Files open
 * into their own window, so the explorer stays put.
 */
export function ExplorerPane({ paneId, root }: { paneId: string; root: string }) {
  const openFilePane = useStore((s) => s.openFilePane);
  const projects = useStore((s) => s.settings?.workspaces ?? []);
  const retargetPane = useStore((s) => s.retargetPane);
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;

  if (!root) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FolderIcon className="h-5 w-5 text-ink-faint" />
        <p className="text-xs text-ink-faint">
          {projects.length === 0
            ? 'Add a project folder in Settings to browse it here.'
            : 'Pick a folder to browse.'}
        </p>
        <div className="flex flex-wrap justify-center gap-1">
          {projects.map((p) => (
            <button
              key={p.id}
              className="btn btn-outline px-2 py-1 text-xs"
              title={p.path}
              onClick={() => retargetPane(paneId, p.path)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-2xs text-ink-faint">
        <FolderIcon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate" title={root}>{name}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <DirTree root={root} onOpen={openFilePane} />
      </div>
    </div>
  );
}
