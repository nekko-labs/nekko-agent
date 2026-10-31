import React, { useEffect, useState } from 'react';
import type { DirEntry } from '@nekko-agent/shared';
import { FileTypeIcon } from '../fileIcons.js';
import { FolderIcon } from '../icons.js';

/**
 * A lightweight VS Code–style file explorer: the lazy-loading tree body for one
 * folder, each directory fetching its children the first time it's expanded.
 * Clicking a file opens it in a FilePane (view/edit in-app). Not a full IDE
 * tree, no rename/DnD yet, just enough to browse and open without leaving
 * Nekko Agent. The disclosure header belongs to the caller: in the Context panel
 * each project folder's accordion row is the header for its tree.
 */
export function DirTree({ root, onOpen }: { root: string; onOpen: (path: string) => void }) {
  return <DirChildren path={root} depth={0} onOpen={onOpen} />;
}

function DirChildren({ path, depth, onOpen }: { path: string; depth: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    window.nekko.listDir(path).then((e) => { if (live) setEntries(e); }).catch(() => { if (live) setEntries([]); });
    return () => { live = false; };
  }, [path]);

  const pad = 8 + depth * 12;
  if (entries === null) return <p className="py-0.5 text-2xs text-ink-faint" style={{ paddingLeft: pad }}>…</p>;
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((e) =>
        e.dir
          ? <TreeFolder key={e.path} entry={e} depth={depth} onOpen={onOpen} />
          : <TreeFile key={e.path} entry={e} depth={depth} onOpen={onOpen} />,
      )}
    </>
  );
}

function TreeFolder({ entry, depth, onOpen }: { entry: DirEntry; depth: number; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 text-left text-xs text-ink-soft hover:bg-surface-2"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="w-2 shrink-0 text-2xs text-ink-faint">{open ? '▾' : '▸'}</span>
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="truncate">{entry.name}</span>
      </button>
      {open && <DirChildren path={entry.path} depth={depth + 1} onOpen={onOpen} />}
    </>
  );
}

function TreeFile({ entry, depth, onOpen }: { entry: DirEntry; depth: number; onOpen: (path: string) => void }) {
  return (
    <button
      onClick={() => onOpen(entry.path)}
      title={entry.name}
      className="flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 text-left text-xs text-ink-soft hover:bg-surface-2"
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
    >
      <FileTypeIcon name={entry.name} size={14} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}
