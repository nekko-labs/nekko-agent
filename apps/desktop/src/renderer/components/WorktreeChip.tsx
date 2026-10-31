import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitStatus, Session } from '@nekko-agent/shared';
import { WorktreeIcon, BranchIcon, CheckIcon, CloseIcon } from '../icons.js';
import { useStore } from '../store.js';

const shownNotices = new Set<string>();

/** Claim the automatic notice once per chat, including remounts and app restarts. */
export function claimCheckoutNotice(sessionId: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  if (shownNotices.has(sessionId)) return false;
  shownNotices.add(sessionId);
  try {
    const key = `nekko:checkout-notice:${sessionId}`;
    if (storage?.getItem(key)) return false;
    storage?.setItem(key, 'shown');
  } catch { /* The in-memory claim still prevents repeats if storage is unavailable. */ }
  return true;
}

/** Checkout context stays beside the checkout, rather than in the transcript. */
export function WorktreeChip({ session, git, disabled, onChange }: {
  session: Session; git: GitStatus; disabled: boolean; onChange: (session: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 8, top: 8 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isolated = session.gitIsolation !== false && !!git.worktree;
  const notices = [...new Set(Object.values(session.gitWorktrees ?? {}).map((w) => w.notice))];
  const [intro, setIntro] = useState(false);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!isolated || !notices.length || shown.current === session.id) return;
    shown.current = session.id;
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Storage can be disabled. */ }
    if (!claimCheckoutNotice(session.id, storage)) return;
    setIntro(true);
    setOpen(true);
  }, [session.id, isolated, notices.length]);
  const close = () => { clearTimeout(timer.current); setIntro(false); setOpen(false); };
  const enter = () => { clearTimeout(timer.current); setOpen(true); };
  const leave = () => { clearTimeout(timer.current); if (!intro) timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)), top: rect.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { anchor.current?.focus(); close(); } };
    const away = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away); };
  }, [open]);
  const switchMode = async (gitIsolation: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (session.executionMode === 'sandbox') throw new Error('Use the execution picker to leave Sandbox.');
      const executionMode = gitIsolation ? 'worktree' : 'unified';
      const next = await window.nekko.setSessionOptions(session.id, { gitIsolation, executionMode });
      if (!next) throw new Error('Chat no longer exists.');
      onChange(next);
      const settings = useStore.getState().settings;
      await window.nekko.updateSettings({ defaultExecutionMode: executionMode, gitManagement: { ...settings?.gitManagement, mode: gitIsolation ? 'worktree' : 'shared' } });
      await useStore.getState().refreshSettings();
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  return <>
    <button ref={anchor} type="button" aria-label="Git checkout options" aria-haspopup="dialog" aria-expanded={open}
      className="inline-flex min-w-0 items-center gap-1 rounded-sm px-2 py-px"
      style={{ background: 'color-mix(in srgb, var(--accent-2) 13%, transparent)', color: 'var(--accent-2)' }}
      onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave} onClick={enter}>
      {isolated ? <WorktreeIcon className="h-3 w-3 shrink-0" /> : <BranchIcon className="h-3 w-3 shrink-0" />}
      <span className="truncate">{isolated ? git.worktree?.name : git.branch ?? git.head ?? 'detached'}</span>
    </button>
    {open && createPortal(<div ref={panel} role="dialog" aria-label="Git checkout options"
      className="fixed z-50 max-w-[calc(100vw-16px)] w-[340px] rounded-lg border border-line bg-paper p-3 text-xs shadow-(--shadow-float)"
      style={pos} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) leave(); }}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-ink">Git checkout</p>
        <button type="button" aria-label="Close checkout notice" className="rounded p-1 text-ink-soft hover:bg-surface-2 hover:text-ink" onClick={close}>
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-2 space-y-2 text-ink-soft">
        {isolated ? (notices.length ? notices : ['This chat uses an isolated Git worktree from committed HEAD.']).map((notice) =>
          <p key={notice}>{notice.replace(/ Interrupt if you want[\s\S]*?(?= Copied from|$)/, '')}</p>)
          : <p>This chat uses the project’s current Git branch, including local changes. Other chats using this checkout share its files.</p>}
      </div>
      {git.worktree && isolated && <p className="mt-2 break-all text-2xs text-ink-faint">{git.worktree.path}</p>}

      <p className="mt-2 text-2xs text-ink-faint">Applies to this chat and new chats. Existing worktrees are kept; edits and commits are not moved between checkouts.</p>
      {disabled && <p className="mt-2 text-2xs text-ink-faint">Stop the current run before switching.</p>}
      {error && <p role="alert" className="mt-2 text-2xs text-danger">{error}</p>}
      <div className="mt-3 space-y-1">
        {[{ value: true, label: 'Use worktrees' }, { value: false, label: 'Use current Git branch' }].map(({ value, label }) =>
          <button key={label} type="button" disabled={disabled || busy} aria-pressed={(session.gitIsolation !== false) === value}
            className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-ink hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-40"
            onClick={() => void switchMode(value)}>
            <span className="flex items-center gap-2">{value ? <WorktreeIcon className="h-3.5 w-3.5" /> : <BranchIcon className="h-3.5 w-3.5" />}{label}</span>{(session.gitIsolation !== false) === value && <CheckIcon className="h-3 w-3" />}
          </button>)}
      </div>
    </div>, document.body)}
  </>;
}
