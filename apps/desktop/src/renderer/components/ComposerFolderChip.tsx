import { useEffect, useRef, useState } from 'react';
import { getSessionWorkspaceIds, type Session, type WorkspaceFolder } from '@agent-nekko/shared';
import { FileIcon, FolderIcon } from '../icons.js';
import { Toggle } from './primitives/index.js';

/** One folder or file this chat can read. */
export interface AccessItem {
  kind: 'folder' | 'file';
  /** Workspace id for a folder, absolute path for a file. */
  id: string;
  name: string;
  path: string;
  primary?: boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** The folders (primary first) and attached files a chat has access to. */
export function chatAccessItems(session: Pick<Session, 'workspaceId' | 'supportingWorkspaceIds' | 'attachedPaths'> | null, workspaces: WorkspaceFolder[]): AccessItem[] {
  if (!session) return [];
  const folders = getSessionWorkspaceIds(session).flatMap((id): AccessItem[] => {
    const w = workspaces.find((x) => x.id === id);
    return w ? [{ kind: 'folder', id, name: baseName(w.path) || w.name, path: w.path, primary: id === session.workspaceId }] : [];
  });
  const files = (session.attachedPaths ?? []).map((p): AccessItem => ({ kind: 'file', id: p, name: baseName(p), path: p }));
  return [...folders, ...files];
}

/** "agent-nekko", "3 folders", "2 folders · 1 file", or null when there is nothing. */
export function accessLabel(items: AccessItem[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0].name;
  const folders = items.filter((i) => i.kind === 'folder').length;
  const files = items.length - folders;
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [folders && part(folders, 'folder'), files && part(files, 'file')].filter(Boolean).join(' · ');
}

/**
 * The composer's folder-access chip, right after the + button: which folders
 * and files this chat can read. With more than one, hovering lists them all,
 * each with a switch that takes it out of the chat (and puts it back, while
 * the list is still open). Nothing is deleted from disk or from the app's
 * project list; only this chat's access changes.
 */
export function ComposerFolderChip({ session, workspaces, onSessionChange, disabled }: {
  session: Session | null;
  workspaces: WorkspaceFolder[];
  onSessionChange: (s: Session) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Rows switched off while the list is open stay listed, so a slip can be undone.
  const [removed, setRemoved] = useState<AccessItem[]>([]);
  const closeTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const included = chatAccessItems(session, workspaces);
  // First-seen position of each row while the list is open.
  const order = useRef(new Map<string, number>());
  for (const i of included) if (!order.current.has(`${i.kind}:${i.id}`)) order.current.set(`${i.kind}:${i.id}`, order.current.size);
  const label = accessLabel(included);
  // Rows keep their place when switched off, so the next switch is still under the pointer.
  const key = (i: AccessItem) => `${i.kind}:${i.id}`;
  const rows = [...included, ...removed.filter((r) => !included.some((i) => key(i) === key(r)))]
    .sort((a, b) => (order.current.get(key(a)) ?? Infinity) - (order.current.get(key(b)) ?? Infinity));

  useEffect(() => { if (!open) { setRemoved([]); order.current = new Map(); } }, [open]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!session || !label) return null;
  const many = included.length > 1;

  const show = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } setOpen(true); };
  const hide = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 160); };

  const setIncluded = async (item: AccessItem, on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      let next: Session | null = null;
      if (item.kind === 'file') {
        const paths = session.attachedPaths ?? [];
        next = await window.nekko.setSessionAttachments(session.id, on ? Array.from(new Set([...paths, item.path])) : paths.filter((p) => p !== item.path));
      } else {
        const supporting = session.supportingWorkspaceIds ?? [];
        let primary = session.workspaceId;
        let rest = supporting.filter((id) => id !== item.id);
        if (on) {
          if (!primary) primary = item.id;
          else rest = [...rest, item.id];
        } else if (primary === item.id) {
          [primary, ...rest] = rest;
        }
        await window.nekko.setSessionWorkspace(session.id, primary);
        next = await window.nekko.setSessionSupportingWorkspaces(session.id, rest);
      }
      if (next) onSessionChange(next);
      setRemoved((r) => (on ? r.filter((x) => !(x.kind === item.kind && x.id === item.id)) : [...r, item]));
    } finally {
      setBusy(false);
    }
  };

  const Icon = included.length === 1 && included[0].kind === 'file' ? FileIcon : FolderIcon;
  return (
    <div
      ref={rootRef}
      className="relative min-w-0"
      data-composer-access
      onMouseEnter={many ? show : undefined}
      onMouseLeave={many ? hide : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
    >
      <button
        type="button"
        className="inline-flex h-7 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg border border-line px-2 text-[11px] text-ink-soft hover:bg-surface-2 hover:text-ink"
        onClick={() => setOpen((o) => !o)}
        title={many ? 'Folders and files this chat can read' : `This chat can read ${included[0].path}`}
        aria-label={`Folder access: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div
          className="card absolute bottom-full left-0 z-40 mb-2 w-72 p-1.5 shadow-lg"
          role="dialog"
          aria-label="Folder access"
          onMouseEnter={many ? show : undefined}
        >
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">Included in this chat</div>
          <ul className="max-h-64 overflow-y-auto">
            {rows.map((item) => {
              const on = included.some((i) => i.kind === item.kind && i.id === item.id);
              const RowIcon = item.kind === 'file' ? FileIcon : FolderIcon;
              return (
                <li key={`${item.kind}:${item.id}`} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-2">
                  <RowIcon className={`h-3.5 w-3.5 shrink-0 ${on && item.primary ? 'text-accent' : 'text-ink-faint'}`} />
                  <span className="min-w-0 flex-1" title={item.path}>
                    <span className={`block truncate text-[12px] ${on ? 'text-ink' : 'text-ink-faint line-through'}`}>{item.name}</span>
                    <span className="block truncate text-[10px] text-ink-faint">{item.primary && on ? 'Primary · ' : ''}{item.path}</span>
                  </span>
                  <Toggle
                    value={on}
                    disabled={disabled || busy}
                    onChange={(v) => { void setIncluded(item, v); }}
                    label={`${on ? 'Remove' : 'Include'} ${item.name}`}
                    title={on ? 'Remove from this chat' : 'Include in this chat'}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
