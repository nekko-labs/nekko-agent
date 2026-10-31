import { SHORTCUTS } from '../shortcuts.js';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { CalendarIcon, CloseIcon, ExternalIcon } from '../icons.js';
import { NekkoAvatar } from './Mascot.js';
import { RangeCalendar } from './RangeCalendar.js';
import {
  FINDER_DEBOUNCE_MS, FINDER_LIMIT, FINDER_SCOPES, PROVIDER_SECTIONS, chatGroupKey, facetResults, finderAge, finderTerms, groupFacets,
  matchChat, needsTranscripts, providerFacets, providerKey, rangeLabel, searchArtifacts, searchChats,
  type DateRange, type FacetResult, type FinderHit, type FinderScope,
} from '../views/chatFinder.js';
import { chatIndex, refreshChatIndex, staleChats, type IndexProgress } from '../views/chatFinderIndex.js';

const WIDTH = 420;
/** Chats a group or provider shows before "Show all". */
const FACET_PREVIEW = 5;

const KIND_LABEL = { title: '', description: 'Description', message: 'Messages', artifact: 'Artifact' } as const;

/**
 * Search chats from the Agents panel: a popup under the search button. Tabs
 * pick what to search (everything, chat titles and descriptions, full
 * messages, artifacts, chat groups, providers), a single-month calendar picks
 * a from–to date range, and every row opens its chat. Searches run once typing
 * pauses for a second, or at once on Enter / the Nekko button.
 *
 * Titles and descriptions come from the summaries already in the store.
 * Messages and artifacts come from the transcript index, read once per chat
 * version and kept while the app runs; until it has read every chat the popup
 * says so, so a partial result is never shown as complete.
 */
export function ChatFinder({ anchorRef, onOpen, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { sessions, providers, workspaces } = useStore(useShallow((s) => ({
    sessions: s.sessions,
    providers: s.providers,
    workspaces: s.settings?.workspaces ?? EMPTY,
  })));
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<FinderScope>('all');
  const [range, setRange] = useState<DateRange | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [indexTick, setIndexTick] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = draft.trim() !== query.trim();
  const now = useMemo(() => Date.now(), [query, sessions, range]);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(WIDTH, window.innerWidth - 16);
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - width - 8, r.left)), width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  const placed = pos !== null;
  useEffect(() => { if (placed) inputRef.current?.focus(); }, [placed]);

  // Search once typing pauses, not on every key.
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setQuery(draft), FINDER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [draft, pending]);

  // Read transcripts only when a search needs them; what is read stays for next time.
  const wantIndex = needsTranscripts(scope, query) || ((scope === 'groups' || scope === 'providers') && !!query.trim());
  const sessionsKey = useMemo(() => sessions.map((s) => `${s.id}:${s.updatedAt}`).join('|'), [sessions]);
  useEffect(() => {
    if (!wantIndex) return;
    if (staleChats(sessions).length === 0) { setProgress(null); return; }
    const ctl = new AbortController();
    void refreshChatIndex(sessions, workspaces, (p) => {
      setProgress(p.done >= p.total ? null : p);
      setIndexTick((n) => n + 1);
    }, ctl.signal).catch(() => setProgress(null));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantIndex, sessionsKey, workspaces]);

  useEffect(() => { setCursor(0); }, [query, scope, range]);

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

  const index = chatIndex();
  const terms = useMemo(() => finderTerms(query), [query]);

  const chatResult = useMemo(
    () => (scope === 'all' || scope === 'chats' || scope === 'messages' ? searchChats(sessions, query, { scope, index, range }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, query, scope, range, indexTick],
  );
  const artifactResult = useMemo(
    () => (scope === 'artifacts' ? searchArtifacts(sessions, index, query, { range }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, query, scope, range, indexTick],
  );
  const facets = useMemo((): Array<FacetResult<SessionSummary>> | null => {
    if (scope !== 'groups' && scope !== 'providers') return null;
    const matches = (s: SessionSummary) => !!matchChat(s, terms, index.get(s.id), range);
    return scope === 'groups'
      ? facetResults(sessions, groupFacets(workspaces), (s) => chatGroupKey(s, workspaces), query, matches, range)
      : facetResults(sessions, providerFacets(providers, sessions), providerKey, query, matches, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, workspaces, providers, query, terms, scope, range, indexTick]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const open = (id: string, findText?: string) => {
    if (findText) useStore.setState({ findSeed: { sessionId: id, query: findText } });
    onOpen(id);
    onClose();
  };

  // Every openable row in order, for the arrow keys and Enter.
  const openables: Array<{ key: string; go: () => void }> = [];
  const addOpenable = (key: string, go: () => void) => { openables.push({ key, go }); return openables.length - 1; };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); if (calendarOpen) setCalendarOpen(false); else onClose(); return; }
    if (e.target !== inputRef.current && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(openables.length - 1, c + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on fresh text searches; Enter on settled results opens the highlighted row.
      if (pending) runNow();
      else openables[cursor]?.go();
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-finder-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const runNow = () => { setQuery(draft); inputRef.current?.focus(); };

  const chatRow = (hit: FinderHit<SessionSummary>, key: string, compact = false) => {
    const s = hit.session;
    const i = addOpenable(key, () => open(s.id, hit.findText));
    const label = hit.kind ? (hit.kind === 'message' && hit.messageCount ? `${hit.messageCount} message${hit.messageCount === 1 ? '' : 's'}` : KIND_LABEL[hit.kind]) : '';
    return (
      <div key={key} role="option" aria-selected={i === cursor}>
        <button
          type="button"
          data-finder-index={i}
          data-finder-row={s.id}
          data-finder-kind={hit.kind}
          className={`chat-finder-row flex w-full items-center gap-3 rounded-lg ${compact ? 'px-2 py-1' : 'px-3 py-1'} text-left ${i === cursor ? 'is-cursor' : ''}`}
          onMouseMove={() => { if (i !== cursor) setCursor(i); }}
          onClick={() => open(s.id, hit.findText)}
          title={hit.findText ? `Open and find “${hit.findText}”` : 'Open chat'}
        >
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${compact ? 'text-xs' : 'text-sm'} text-ink`}>{s.title || 'Untitled chat'}</span>
            {hit.snippet && <span className="block truncate text-2xs text-ink-faint">{hit.snippet}</span>}
          </span>
          {label && <span className="chat-finder-badge shrink-0" data-finder-badge>{label}</span>}
          {s.archivedAt ? <span className="shrink-0 text-2xs text-ink-faint">Completed</span> : null}
          <span className="shrink-0 text-2xs tabular-nums text-ink-faint" data-finder-age>{finderAge(s.updatedAt, now)}</span>
        </button>
      </div>
    );
  };

  const empty = (text: string) => <p className="px-3 py-3 text-center text-xs text-ink-faint" role="presentation">{text}</p>;
  const sectionHead = (text: string, count?: number) => (
    <p className="flex items-center gap-2 px-3 pb-1 pt-1 text-xs font-medium text-ink-soft" role="presentation">
      {text}{count !== undefined && <span className="tabular-nums font-normal normal-case tracking-normal">{count}</span>}
    </p>
  );

  const renderFacets = (list: Array<FacetResult<SessionSummary>>) => {
    if (!list.length) return empty(query.trim() || range ? 'Nothing matches' : scope === 'groups' ? 'No chat groups yet' : 'No providers yet');
    const sections = scope === 'providers' ? PROVIDER_SECTIONS.map((p) => ({ id: p.id as string, label: p.label })) : [{ id: '', label: '' }];
    return sections.map((sec) => {
      const inSec = list.filter((f) => (scope === 'providers' ? f.section === sec.id : true));
      if (!inSec.length) return null;
      return (
        <div key={sec.id || 'groups'} data-finder-section={sec.id || undefined}>
          {sec.label && sectionHead(sec.label)}
          {inSec.map((f) => {
            const all = expanded.has(f.key);
            const shown = all ? f.sessions : f.sessions.slice(0, FACET_PREVIEW);
            return (
              <section key={f.key} className="chat-finder-facet mb-1 rounded-lg" data-finder-facet={f.key} aria-label={f.name}>
                <h3 className="flex items-center gap-2 px-3 pb-0.5 pt-1 text-xs font-semibold text-ink">
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className="chat-finder-badge tabular-nums">{f.sessions.length}</span>
                </h3>
                {shown.map((s) => {
                  const hit = terms.length ? matchChat(s, terms, index.get(s.id), range) ?? { session: s } : { session: s };
                  return chatRow(hit, `${f.key}/${s.id}`, true);
                })}
                {f.sessions.length > FACET_PREVIEW && (
                  <button
                    type="button"
                    className="ml-2 px-2 pb-1 text-2xs text-accent hover:underline"
                    data-finder-facet-more={f.key}
                    onClick={() => setExpanded((cur) => { const n = new Set(cur); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n; })}
                  >
                    {all ? 'Show fewer' : `Show all ${f.sessions.length}`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      );
    });
  };

  const results = (() => {
    if (chatResult) {
      if (!chatResult.hits.length) {
        if (scope === 'messages' && !query.trim()) return empty('Type to search inside every message');
        return empty(query.trim() || range ? 'No chats match' : 'No chats yet');
      }
      return (
        <>
          {sectionHead(query.trim() ? 'Matches' : 'Latest', query.trim() || range ? chatResult.total : undefined)}
          {chatResult.hits.map((h) => chatRow(h, h.session.id))}
          {chatResult.total > chatResult.hits.length && empty(`Showing the first ${FINDER_LIMIT} of ${chatResult.total}. Add a word or a date range to narrow it.`)}
        </>
      );
    }
    if (artifactResult) {
      if (!artifactResult.hits.length) return progress ? null : empty(query.trim() || range ? 'No artifacts match' : 'No artifacts yet');
      return (
        <>
          {sectionHead(query.trim() ? 'Matching artifacts' : 'Latest artifacts', artifactResult.total)}
          {artifactResult.hits.map((a) => {
            const chat = byId.get(a.sessionId);
            const i = addOpenable(`a:${a.path}`, () => open(a.sessionId));
            return (
              <div key={a.path} role="option" aria-selected={i === cursor} className="group relative">
                <button
                  type="button"
                  data-finder-index={i}
                  data-finder-artifact={a.path}
                  data-finder-row={a.sessionId}
                  className={`chat-finder-row flex w-full items-center gap-3 rounded-lg px-3 py-1 pr-9 text-left ${i === cursor ? 'is-cursor' : ''}`}
                  onMouseMove={() => { if (i !== cursor) setCursor(i); }}
                  onClick={() => open(a.sessionId)}
                  title={`Open “${chat?.title || a.sessionTitle}”\n${a.path}`}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-2 text-2xs font-semibold uppercase text-ink-faint" aria-hidden>
                    {a.filename.split('.').pop()?.slice(0, 4)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{a.title}</span>
                    <span className="block truncate text-2xs text-ink-faint">{chat?.title || a.sessionTitle} · {a.filename}</span>
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{finderAge(a.at, now)}</span>
                </button>
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-faint opacity-0 hover:bg-surface-2 hover:text-ink focus:opacity-100 group-hover:opacity-100 touch:opacity-100"
                  title="Open the file with the system's default app"
                  aria-label={`Open file ${a.filename}`}
                  onClick={() => void window.nekko.openPath(a.path)}
                >
                  <ExternalIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </>
      );
    }
    return facets ? renderFacets(facets) : null;
  })();

  if (!pos) return null;
  return createPortal(
    <div
      ref={popRef}
      data-chat-finder
      role="dialog"
      aria-label="Search chats"
      className="chat-finder card fixed z-[1000] flex flex-col p-2 shadow-(--shadow-float)"
      style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100dvh - ${pos.top + 12}px)` }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        <kbd className="kbd shrink-0">{SHORTCUTS.searchChats.label}</kbd>
        <input
          ref={inputRef}
          className="chat-finder-input min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none"
          placeholder={SCOPE_PLACEHOLDER[scope]}
          aria-label="Search chats"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <button
          type="button"
          className={`chat-finder-tool grid h-7 w-7 shrink-0 place-items-center rounded-md ${range || calendarOpen ? 'is-on' : ''}`}
          title={range ? `Dates: ${rangeLabel(range)}` : 'Filter by date range'}
          aria-label="Filter by date range"
          aria-expanded={calendarOpen}
          data-finder-date
          onClick={() => setCalendarOpen((o) => !o)}
        >
          <CalendarIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="send-avatar grid h-8 w-8 shrink-0 place-items-center rounded-xl transition-[background-color,border-color,color,opacity,transform] duration-150"
          title="Search now (Enter)"
          aria-label="Search now"
          data-finder-search
          onClick={runNow}
        >
          <NekkoAvatar size={22} />
        </button>
        <button
          type="button"
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
      <div className="chat-finder-tabs flex gap-1 overflow-x-auto px-1 pb-1 pt-1" role="tablist" aria-label="What to search">
        {FINDER_SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={scope === s.id}
            data-finder-scope={s.id}
            className={`chat-finder-chip shrink-0 ${scope === s.id ? 'is-on' : ''}`}
            onClick={() => { setScope(s.id); setQuery(draft); inputRef.current?.focus(); }}
          >
            {s.label}
          </button>
        ))}
      </div>
      {range && !calendarOpen && (
        <div className="flex items-center gap-2 px-2 pb-1 text-2xs text-ink-faint">
          <CalendarIcon className="h-3 w-3" />
          <button type="button" className="text-ink hover:underline" data-finder-range-label onClick={() => setCalendarOpen(true)}>{rangeLabel(range)}</button>
          <button type="button" className="grid h-4 w-4 place-items-center rounded hover:bg-surface-2 hover:text-ink" aria-label="Clear date range" data-finder-range-x onClick={() => setRange(null)}>
            <CloseIcon className="h-3 w-3" />
          </button>
        </div>
      )}
      {calendarOpen && (
        <div className="chat-finder-calendar-wrap mx-1 mb-1 rounded-lg">
          <RangeCalendar value={range} now={now} onChange={(r) => { setRange(r); if (r) setCalendarOpen(false); }} />
        </div>
      )}
      {progress && (
        <p className="flex items-center gap-2 px-3 pb-1 text-2xs text-ink-faint" data-finder-indexing aria-live="polite">
          <span className="chat-finder-spinner" aria-hidden />
          Reading chats {progress.done} of {progress.total}; results so far
        </p>
      )}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-0.5"
        style={{ maxHeight: 'min(440px, 60vh)' }}
        role="listbox"
        aria-label={query.trim() ? 'Search results' : 'Latest'}
      >
        {results}
      </div>
    </div>,
    document.body,
  );
}

const EMPTY: never[] = [];

const SCOPE_PLACEHOLDER: Record<FinderScope, string> = {
  all: 'Search chats, messages and artifacts',
  chats: 'Search chat titles and descriptions',
  messages: 'Search inside every message',
  artifacts: 'Search artifacts by name or file',
  groups: 'Search chat groups',
  providers: 'Search providers, local or cloud',
};
