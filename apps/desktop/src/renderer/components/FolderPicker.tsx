import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uniqueFolders, type RemoteRepo, type SandboxRepo, type Session, type SessionMeta, type WorkspaceFolder } from '@nekko-agent/shared';
import { CloseIcon, FolderIcon, PlugIcon, PlusIcon, StarIcon, TrashIcon } from '../icons.js';
import { ConnectorIcon } from '../connectorIcons.js';
import { useStore } from '../store.js';
import { toggleDefaultFolder } from '../defaultFolders.js';
import { addFolderToChat, addRepoToChat, applyFolderSelection, hasRepoProvider, withoutPrimary, withPrimary, withExcluded } from '../sessionFolders.js';
import { MiddleTruncate } from './primitives/MiddleTruncate.js';
import { RepoBrowser } from './RepoBrowser.js';

type ChatFolders = Pick<SessionMeta, 'workspaceId' | 'supportingWorkspaceIds'>;
const NO_DEFAULTS: string[] = [];

/** The menu's section headings. */
function Heading({ children }: { children: React.ReactNode }) {
  return <div role="presentation" className="px-3 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">{children}</div>;
}

/**
 * The Environment menu body (#2404): the chat's local folders, then its
 * repositories from a git provider, each with an add action (or "Connect
 * repositories" when no provider is connected), then "No folder".
 */
export function FolderPickerMenu({ folders, chat, defaults = [], onPick, onClear, onAdd, onRemove, onExclude, onToggleDefault, reposConnected, onAddRepo, onConnectRepos, sandboxRepos = [], onRemoveSandboxRepo }: {
  folders: WorkspaceFolder[];
  chat: ChatFolders | null;
  /** Starred folders new chats start with. */
  defaults?: string[];
  onPick: (id: string) => void;
  onClear: () => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  /** Unwire only this chat, without revoking the saved folder for other chats. */
  onExclude?: (id: string) => void;
  onToggleDefault?: (id: string) => void;
  /** A GitHub or GitLab connector is connected. */
  reposConnected?: boolean;
  /** Browse the connected accounts' repositories. Without it the Repositories section is hidden. */
  onAddRepo?: () => void;
  onConnectRepos?: () => void;
  /** A sandbox chat's repositories that live only in its sandbox (#2561). */
  sandboxRepos?: SandboxRepo[];
  onRemoveSandboxRepo?: (repo: SandboxRepo) => void;
}) {
  const primary = chat?.workspaceId;
  const supporting = new Set(chat?.supportingWorkspaceIds ?? []);
  // min-w-0 flex-1: a long name or path shrinks the row instead of pushing
  // the revoke button out of the menu.
  const row = 'flex min-w-0 flex-1 flex-col rounded-lg px-3 py-1 text-left hover:bg-surface-2';
  const action = 'flex w-full items-center gap-2 rounded-lg px-3 py-1 text-left text-xs text-accent hover:bg-surface-2';
  const local = folders.filter((f) => !f.repo);
  const repos = folders.filter((f) => f.repo);
  const showRepos = !!onAddRepo || !!onConnectRepos;

  const folderRow = (f: WorkspaceFolder) => {
      const starred = defaults.includes(f.id);
      return (
      <div key={f.id} className="flex items-center">
        {onToggleDefault && (
          <button type="button" aria-pressed={starred} aria-label={starred ? `Stop starting new chats in ${f.name}` : `Start new chats in ${f.name}`}
            title={starred ? 'Default for new chats (click to unset)' : 'Set as default for new chats'}
            className={`shrink-0 rounded p-2 hover:bg-surface-2 ${starred ? 'text-accent' : 'text-ink-faint hover:text-ink'}`} onClick={() => onToggleDefault(f.id)}>
            <StarIcon className="h-3.5 w-3.5" filled={starred} />
          </button>
        )}
        <button role="menuitemradio" aria-checked={primary === f.id} title={f.path}
          className={`${row} ${primary === f.id ? 'text-accent' : ''}`} onClick={() => onPick(f.id)}>
          <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
            {f.repo && <span className="shrink-0"><ConnectorIcon kind={f.repo.provider} size={12} /></span>}
            <span className="min-w-0 truncate" dir="auto">{f.repo?.fullName ?? f.name}</span>
            {supporting.has(f.id) && <span className="shrink-0 text-2xs font-normal text-ink-faint">supporting</span>}
          </span>
          <MiddleTruncate text={f.path} tail={24} className="text-2xs text-ink-faint" />
        </button>
        {onExclude && (primary === f.id || supporting.has(f.id)) && <button type="button" aria-label={`Remove ${f.name} from this chat`} title="Remove from this chat, keep saved folder access" className="shrink-0 rounded p-2 text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={() => onExclude(f.id)}>
          <CloseIcon className="h-3.5 w-3.5" />
        </button>}
        <button type="button" aria-label={`Revoke access to ${f.name}`} title="Revoke saved folder access, not delete files" className="shrink-0 rounded p-2 text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={() => onRemove(f.id)}>
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      );
  };

  return <>
    {showRepos && <Heading>Folders</Heading>}
    {(showRepos ? local : folders).map(folderRow)}
    <button role="menuitem" className={action} onClick={onAdd}>
      <PlusIcon className="h-3.5 w-3.5" /> Add folder…
    </button>

    {showRepos && <>
      <div className="mt-1 border-t border-line pt-1" role="presentation" />
      <Heading>Repositories</Heading>
      {repos.map(folderRow)}
      {sandboxRepos.map((r) => (
        <div key={`${r.provider}:${r.fullName}`} className="flex items-center" data-sandbox-repo>
          {/* Lines up with the folders' star column; a sandbox repository is never a default. */}
          {onToggleDefault && <span aria-hidden className="shrink-0 p-2"><span className="block h-3.5 w-3.5" /></span>}
          <span className={`${row} hover:bg-transparent`} title={`${r.fullName} is cloned into this chat's sandbox, not onto this computer`}>
            <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
              <span className="shrink-0"><ConnectorIcon kind={r.provider} size={12} /></span>
              <span className="min-w-0 truncate" dir="auto">{r.fullName}</span>
            </span>
            <span className="text-2xs text-ink-faint">In the sandbox</span>
          </span>
          {onRemoveSandboxRepo && <button type="button" aria-label={`Remove ${r.fullName} from this chat`} title="Remove from this chat" className="shrink-0 rounded p-2 text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={() => onRemoveSandboxRepo(r)}>
            <CloseIcon className="h-3.5 w-3.5" />
          </button>}
        </div>
      ))}
      {reposConnected && onAddRepo
        ? <button role="menuitem" className={action} onClick={onAddRepo}><PlusIcon className="h-3.5 w-3.5" /> Add repository…</button>
        : <button role="menuitem" className={action} onClick={onConnectRepos} title="Connect GitHub or GitLab in Connectors"><PlugIcon className="h-3.5 w-3.5" /> Connect repositories</button>}
    </>}

    <div className="mt-1 border-t border-line pt-1">
      <button role="menuitemradio" aria-checked={!primary} className={`${row} ${!primary ? 'text-accent' : ''}`} onClick={onClear}>
        <span className="text-xs font-medium">No folder</span>
        <span className="text-2xs text-ink-faint">No working directory</span>
      </button>
    </div>
  </>;
}

/** Ask the composer's Environment menu to open on its repository list. */
export const ADD_REPO_EVENT = 'nekko:environment-add-repo';
export function openRepoBrowser(sessionId: string) {
  window.dispatchEvent(new CustomEvent(ADD_REPO_EVENT, { detail: { sessionId } }));
}

/**
 * The chat's primary folder, picked from the composer's bottom strip. Picking
 * another folder keeps the old primary as supporting, as the Context
 * Inspector's Folders section does.
 */
export function FolderPicker({ sessionId, session, disabled, onChange, selectedSummary = false }: {
  sessionId: string;
  selectedSummary?: boolean;
  session: Session | null;
  disabled?: boolean;
  onChange: (session: Session) => void;
}) {
  // Older profiles can still hold one folder under two ids; show it once.
  const saved = useStore((s) => s.settings?.workspaces);
  const folders = useMemo(() => uniqueFolders(saved ?? []).folders, [saved]);
  const defaults = useStore((s) => s.settings?.defaultWorkspaceIds) ?? NO_DEFAULTS;
  // The store's summary sees Context Inspector edits the pane's own copy misses.
  const summary = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const chat: ChatFolders | null = summary ?? session;
  const primary = folders.find((f) => f.id === chat?.workspaceId);
  const selected = [primary, ...folders.filter((f) => f.id !== primary?.id && chat?.supportingWorkspaceIds?.includes(f.id))].filter((f): f is WorkspaceFolder => !!f);
  const names = selected.map((f) => f.name).join(', ');

  const reposConnected = hasRepoProvider(useStore((s) => s.settings?.connectors));
  const [open, setOpen] = useState(false);
  // 'repos': the menu shows the connected accounts' repositories to clone.
  const [mode, setMode] = useState<'list' | 'repos'>('list');
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
  useEffect(() => { if (!open) setMode('list'); }, [open]);

  // The composer's + menu (and anything else) can open the repository list.
  useEffect(() => {
    const show = (e: Event) => {
      if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId || disabled) return;
      setMode('repos');
      setOpen(true);
    };
    window.addEventListener(ADD_REPO_EVENT, show);
    return () => window.removeEventListener(ADD_REPO_EVENT, show);
  }, [sessionId, disabled]);
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
  const connectRepos = () => { setOpen(false); useStore.getState().setView('connectors'); };
  // The menu stays open while a clone runs; the browser shows its progress.
  const addRepo = async (repo: RemoteRepo) => {
    const { session: s, path } = await addRepoToChat(sessionId, chat, repo);
    if (s) onChange(s);
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    useStore.getState().pushToast('success', `Added ${repo.fullName} to this chat (${path})`);
  };

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
        aria-label={selectedSummary ? `Environment: ${names || 'none'}` : `Primary folder: ${primary?.name ?? 'none'}`}
        title={selectedSummary && selected.length ? `${selected.map((f) => f.path).join('\n')}${disabled ? '\nThe environment can change once the reply finishes' : ''}` : disabled ? 'The environment can change once the reply finishes' : primary?.path ?? 'Choose the folders and repositories this agent works in'}
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{selectedSummary ? names || 'No folder' : primary?.name ?? 'No folder'}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && createPortal(
        mode === 'repos'
          ? <div ref={menu} style={position} className="card fixed z-[100] flex flex-col overflow-hidden p-2 shadow-(--shadow-float)" role="dialog" aria-label="Add a repository">
              <button type="button" className="mb-1 flex items-center gap-1 rounded-lg px-2 py-1 text-left text-xs text-ink-faint hover:bg-surface-2 hover:text-ink" onClick={() => setMode('list')}>
                <span aria-hidden>‹</span> Environment
              </button>
              <RepoBrowser onPick={addRepo} onConnect={connectRepos} />
            </div>
          : <div ref={menu} style={position} className="card fixed z-[100] overflow-y-auto p-2 shadow-(--shadow-float)" role="menu" aria-label="Environment">
              <FolderPickerMenu folders={folders} chat={chat} defaults={defaults} onPick={pick} onClear={clear} onAdd={add} onRemove={remove} onExclude={(id) => run(() => applyFolderSelection(sessionId, withExcluded(chat, id)))} onToggleDefault={toggleDefaultFolder}
                reposConnected={reposConnected} onAddRepo={() => setMode('repos')} onConnectRepos={connectRepos}
                sandboxRepos={session?.sandboxRepos ?? session?.sandbox?.sourceRepos}
                onRemoveSandboxRepo={session && !session.sandbox ? (r) => run(() => window.nekko.setSandboxRepos(sessionId, (session.sandboxRepos ?? []).filter((x) => x !== r))) : undefined} />
            </div>, document.body,
      )}
    </div>
  );
}
