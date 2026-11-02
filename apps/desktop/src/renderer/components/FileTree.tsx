import React, { useEffect, useState } from 'react';
import type { DirEntry } from '@nekko-agent/shared';
import { FileTypeIcon } from '../fileIcons.js';
import { FolderIcon } from '../icons.js';
import { MiddleTruncate } from './primitives/MiddleTruncate.js';

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

/** Rows a folder shows before "Show more": a 10,000-file folder is not 10,000 buttons. */
export const TREE_PAGE = 200;

function DirChildren({ path, depth, onOpen }: { path: string; depth: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(TREE_PAGE);
  useEffect(() => {
    let live = true;
    setFailed(false);
    window.nekko.listDir(path).then((e) => { if (live) setEntries(e); }).catch(() => { if (live) { setEntries([]); setFailed(true); } });
    return () => { live = false; };
  }, [path]);

  const pad = 8 + depth * 12;
  if (entries === null) return <p className="py-0.5 text-2xs text-ink-faint" style={{ paddingLeft: pad }}>…</p>;
  if (entries.length === 0) {
    return <p className="py-0.5 text-2xs text-ink-faint" style={{ paddingLeft: pad + 10 }}>{failed ? 'Can’t read this folder' : 'Empty folder'}</p>;
  }
  const rest = entries.length - shown;
  return (
    <>
      {entries.slice(0, shown).map((e) =>
        e.dir
          ? <TreeFolder key={e.path} entry={e} depth={depth} onOpen={onOpen} />
          : <TreeFile key={e.path} entry={e} depth={depth} onOpen={onOpen} />,
      )}
      {rest > 0 && (
        <button type="button" className="w-full py-0.5 pr-2 text-left text-2xs text-ink-faint hover:text-ink" style={{ paddingLeft: pad + 10 }} onClick={() => setShown((n) => n + TREE_PAGE)}>
          Show {Math.min(rest, TREE_PAGE).toLocaleString()} more of {rest.toLocaleString()}
        </button>
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
        className="flex w-full items-center gap-2 rounded-sm py-0.5 pr-2 text-left text-xs text-ink-soft hover:bg-surface-2"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="w-2 shrink-0 text-2xs text-ink-faint">{open ? '▾' : '▸'}</span>
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="truncate" title={entry.name} dir="auto">{entry.name}</span>
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
      className="flex w-full items-center gap-2 rounded-sm py-0.5 pr-2 text-left text-xs text-ink-soft hover:bg-surface-2"
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
    >
      <FileTypeIcon name={entry.name} size={14} />
      <MiddleTruncate text={entry.name} tail={10} />
    </button>
  );
}
