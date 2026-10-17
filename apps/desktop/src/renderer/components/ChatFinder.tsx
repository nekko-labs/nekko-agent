import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store.js';
import { CloseIcon } from '../icons.js';
import { NekkoAvatar } from './Mascot.js';
import { FINDER_DEBOUNCE_MS, findChats, finderAge } from '../views/chatFinder.js';

const WIDTH = 360;

/**
 * Find a chat from the Agents panel: a popup under the search button, latest
 * chats first, filtered once typing pauses (or at once on Enter / the Nekko
 * button). Rows open their chat. It reads the summaries already in the store,
 * so nothing here waits on the host.
 */
export function ChatFinder({ anchorRef, onOpen, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const now = useMemo(() => Date.now(), [query, sessions]);
  const hits = useMemo(() => findChats(sessions, query), [sessions, query]);
  const pending = draft.trim() !== query.trim();

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - WIDTH - 8, r.left)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Search once typing pauses, not on every key.
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setQuery(draft), FINDER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [draft, pending]);

  useEffect(() => { setCursor(0); }, [query]);

  // Close on an outside press.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [anchorRef, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-finder-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const runNow = () => { setQuery(draft); inputRef.current?.focus(); };
  const open = (id: string) => { onOpen(id); onClose(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on fresh text searches; Enter on settled results opens the highlighted chat.
      if (pending) runNow();
      else if (hits[cursor]) open(hits[cursor].session.id);
    }
  };

  if (!pos) return null;
  return createPortal(
    <div
      ref={popRef}
      data-chat-finder
      role="dialog"
      aria-label="Search chats"
      className="chat-finder card fixed z-[1000] flex flex-col p-1.5 shadow-lg"
      style={{ top: pos.top, left: pos.left, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <input
          ref={inputRef}
          className="chat-finder-input min-w-0 flex-1 bg-transparent px-1.5 py-1.5 text-[13px] outline-none"
          placeholder="Search chats"
          aria-label="Search chats"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <button
          className="send-avatar grid h-8 w-8 shrink-0 place-items-center rounded-xl transition-all duration-150"
          title="Search now (Enter)"
          aria-label="Search now"
          data-finder-search
          onClick={runNow}
        >
          <NekkoAvatar size={22} />
        </button>
        <button
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink"
          title="Close (Esc)"
          aria-label="Close search"
          data-finder-close
          onClick={onClose}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      {/* Keyed on the text so every keystroke restarts the fill. */}
      <div key={draft} className="chat-finder-progress" data-active={pending || undefined} aria-hidden />
      <ul ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain pt-1" role="listbox" aria-label={query.trim() ? 'Matching chats' : 'Latest chats'}>
        {!query.trim() && hits.length > 0 && <li className="px-2.5 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint" role="presentation">Latest</li>}
        {hits.map(({ session: s, snippet }, i) => (
          <li key={s.id} role="option" aria-selected={i === cursor}>
            <button
              data-finder-index={i}
              data-finder-row={s.id}
              className={`chat-finder-row flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left ${i === cursor ? 'is-cursor' : ''}`}
              onMouseMove={() => { if (i !== cursor) setCursor(i); }}
              onClick={() => open(s.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{s.title || 'Untitled chat'}</span>
                {snippet && <span className="block truncate text-[11px] text-ink-faint">{snippet}</span>}
              </span>
              {s.archivedAt ? <span className="shrink-0 text-[10px] text-ink-faint">Completed</span> : null}
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint" data-finder-age>{finderAge(s.updatedAt, now)}</span>
            </button>
          </li>
        ))}
        {hits.length === 0 && (
          <li className="px-2.5 py-3 text-center text-[12px] text-ink-faint" role="presentation">
            {query.trim() ? 'No chats match' : 'No chats yet'}
          </li>
        )}
      </ul>
    </div>,
    document.body,
  );
}
