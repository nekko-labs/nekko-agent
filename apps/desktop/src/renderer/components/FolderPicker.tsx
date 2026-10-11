import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uniqueFolders, type Session, type SessionMeta, type WorkspaceFolder } from '@nekko-agent/shared';
import { CloseIcon, FolderIcon, PlusIcon } from '../icons.js';
import { useStore } from '../store.js';
import { addFolderToChat, applyFolderSelection, withoutPrimary, withPrimary } from '../sessionFolders.js';

type ChatFolders = Pick<SessionMeta, 'workspaceId' | 'supportingWorkspaceIds'>;

/** The menu body: one row per folder, "No folder", then "Add folder…". */
export function FolderPickerMenu({ folders, chat, onPick, onClear, onAdd, onRemove }: {
  folders: WorkspaceFolder[];
  chat: ChatFolders | null;
  onPick: (id: string) => void;
  onClear: () => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const primary = chat?.workspaceId;
  const supporting = new Set(chat?.supportingWorkspaceIds ?? []);
  const row = 'flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2';

  return <>
    {folders.map((f) => (
      <div key={f.id} className="flex items-center">
        <button role="menuitemradio" aria-checked={primary === f.id} title={f.path}
          className={`${row} ${primary === f.id ? 'text-accent' : ''}`} onClick={() => onPick(f.id)}>
          <span className="flex items-center gap-1.5 text-[12px] font-medium">
            {f.name}
            {supporting.has(f.id) && <span className="text-[10px] font-normal text-ink-faint">supporting</span>}
          </span>
          <span className="truncate text-[10px] text-ink-faint">{f.path}</span>
        </button>
        <button type="button" aria-label={`Revoke access to ${f.name}`} title="Revoke saved folder access, not delete files" className="shrink-0 rounded p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={() => onRemove(f.id)}>
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    ))}

    <button role="menuitemradio" aria-checked={!primary} className={`${row} ${!primary ? 'text-accent' : ''}`} onClick={onClear}>
      <span className="text-[12px] font-medium">No folder</span>
      <span className="text-[10px] text-ink-faint">No working directory</span>
    </button>

    <div className="mt-1 border-t border-line pt-1">
      <button role="menuitem" className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-accent hover:bg-surface-2" onClick={onAdd}>
        <PlusIcon className="h-3.5 w-3.5" /> Add folder…
      </button>
    </div>
  </>;
}

/**
 * The chat's primary folder, picked from the composer's bottom strip. Picking
 * another folder keeps the old primary as supporting, as the Context
 * Inspector's Folders section does.
 */
export function FolderPicker({ sessionId, session, disabled, onChange }: {
  sessionId: string;
  session: Session | null;
  disabled?: boolean;
  onChange: (session: Session) => void;
}) {
  // Older profiles can still hold one folder under two ids; show it once.
  const saved = useStore((s) => s.settings?.workspaces);
  const folders = useMemo(() => uniqueFolders(saved ?? []).folders, [saved]);
  // The store's summary sees Context Inspector edits the pane's own copy misses.
  const summary = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const chat: ChatFolders | null = summary ?? session;
  const primary = folders.find((f) => f.id === chat?.workspaceId);

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Portalled and placed like the Mode menu, to escape the composer's clipping.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      if (!anchor) return;
      const above = Math.max(0, anchor.top - 16);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 16);
      const width = Math.min(300, window.innerWidth - 16);
      setPosition({
        width, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        maxHeight: Math.max(above, below),
        ...(above >= below ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 }),
      });
    };
    place();
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!button.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus({ preventScroll: true }); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const run = (work: () => Promise<Session | null>) => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    work()
      .then((s) => { if (s) onChange(s); })
      .catch((e) => useStore.getState().pushToast('error', String(e)));
  };
  const pick = (id: string) => { if (id !== chat?.workspaceId) run(() => applyFolderSelection(sessionId, withPrimary(chat, id))); else { useStore.getState().setActiveProject(id); setOpen(false); } };
  const clear = () => { if (chat?.workspaceId) run(() => applyFolderSelection(sessionId, withoutPrimary(chat))); else { useStore.getState().setActiveProject(null); setOpen(false); } };
  const add = () => run(() => addFolderToChat(sessionId, chat, 'primary'));

  // Revoking one folder is housekeeping inside the list, not a choice that
  // ends the menu: it stays open so several can be cleared in a row.
  const remove = (id: string) => {
    void (async () => {
      await window.nekko.removeWorkspace(id);
      if (useStore.getState().activeProjectId === id) useStore.getState().setActiveProject(null);
      await useStore.getState().refreshSettings();
      await useStore.getState().refreshSessions();
      const s = await window.nekko.getSession(sessionId);
      if (s) onChange(s);
    })().catch((e) => useStore.getState().pushToast('error', String(e)));
  };

  return (
    <div className="relative min-w-0 shrink">
      <button
        ref={button}
        type="button"
        className="ctl-menu max-w-[220px]"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Primary folder: ${primary?.name ?? 'none'}`}
        title={disabled ? 'Folder can change once the reply finishes' : primary?.path ?? 'Choose the folder this agent works in'}
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{primary?.name ?? 'No folder'}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && createPortal(
        <div ref={menu} style={position} className="card fixed z-[100] overflow-y-auto p-1.5 shadow-lg" role="menu" aria-label="Primary folder">
          <FolderPickerMenu folders={folders} chat={chat} onPick={pick} onClear={clear} onAdd={add} onRemove={remove} />
        </div>, document.body,
      )}
    </div>
  );
}
