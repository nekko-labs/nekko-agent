import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { getCachedSession, loadSession } from '../sessionCache.js';
import { hasAppChrome } from '../chrome.js';
import { prefersReducedMotion } from '../displays.js';
import { FilePane } from '../components/FilePane.js';
import { LibraryArtwork, LibraryIntro, libraryIntroSeen, dismissLibraryIntro } from '../components/LibraryIntro.js';
import { SlideToggle, type SlideOption } from '../components/library/SlideToggle.js';
import { ArtifactPreview } from '../components/library/ArtifactPreview.js';
import { DesignCanvas } from '../components/library/DesignCanvas.js';
import { TilePreview } from '../components/library/TilePreview.js';
import {
  LIBRARY_LAYOUTS, PREVIEW_LIMIT, loadCollapsedKinds, loadLibraryLayout, orderForProfile, saveCollapsedKinds, saveLibraryLayout,
  type LibraryLayout,
} from '../components/library/libraryPrefs.js';
import { ChevronDownIcon, ChevronIcon, ExternalIcon, FocusLayoutIcon } from '../icons.js';
import {
  ARTIFACT_KINDS, artifactCandidates, folderDesigns, groupArtifacts, groupDesignVersions, mergeArtifacts, presentPaths, readDesignsFolder, sessionArtifacts, withFolderDesigns,
  type ArtifactEntry, type ArtifactKind,
} from '../artifactsIndex.js';

/** Where a chat's relative links resolve: its checkout of the primary folder, else that folder. */
function basePathOf(session: { workspaceId?: string; gitWorktrees?: Record<string, { path?: string }> }, workspaces: Array<{ id: string; path: string }>): string | undefined {
  if (!session.workspaceId) return undefined;
  return session.gitWorktrees?.[session.workspaceId]?.path ?? workspaces.find((w) => w.id === session.workspaceId)?.path;
}

const when = (at: number) => {
  const d = new Date(at);
  return at <= 0 || Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
/** Where a file came from: its chat, or for a design found in a project's designs folder, that project. */
const cameFrom = (e: ArtifactEntry) => (e.sessionId ? e.sessionTitle : `${e.sessionTitle} designs folder`);
const fromAndWhen = (e: ArtifactEntry) => [cameFrom(e), when(e.at), e.versions && `${e.versions.length} versions`].filter(Boolean).join(' · ');
/** A design the canvas can show: an HTML page. Images and the rest open in the file pane. */
const isHtml = (path: string) => /\.html?$/i.test(path);
const extOf = (filename: string) => (filename.includes('.') ? filename.split('.').pop() ?? '' : '');

type Group = { kind: (typeof ARTIFACT_KINDS)[number]; items: ArtifactEntry[] };
type Show = 'all' | ArtifactKind;

/**
 * Run a Library change as a view transition: tiles glide from their old place
 * and size to the new one, and the list widens or narrows. `listChanges` says
 * whether the list's own picture changes (its width or its rows), which plays
 * it as a panel sweeping to its new width rather than a crossfade. Instant when
 * the OS asks for less motion or the browser has no view transitions.
 */
let transitions = 0;
function transition(update: () => void, listChanges: boolean) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!doc.startViewTransition || prefersReducedMotion()) { update(); return; }
  const root = document.documentElement;
  const done = () => { if (--transitions === 0) { delete root.dataset.libraryTransition; nameMovers(false); } };
  transitions++;
  root.dataset.libraryTransition = listChanges ? 'list' : 'grid';
  nameMovers(true);
  try {
    doc.startViewTransition(() => { flushSync(update); nameMovers(true); }).finished.finally(done);
  } catch {
    done();
    update();
  }
}

/**
 * Give the canvas's on-screen previews, labels and group headings their
 * transition names, so each glides as its own layer. Off-screen ones stay
 * unnamed: every name costs a snapshot. Cleared once the transition ends.
 */
function nameMovers(on: boolean) {
  const view = document.querySelector('[data-library-canvas]')?.getBoundingClientRect();
  for (const el of document.querySelectorAll<HTMLElement>('[data-library-mover]')) {
    const r = el.getBoundingClientRect();
    const named = on && !!view && r.width > 0 && r.bottom > view.top - 80 && r.top < view.bottom + 80;
    el.style.setProperty('view-transition-name', named ? el.dataset.libraryMover! : '');
    el.style.setProperty('view-transition-class', named ? el.dataset.libraryMoverClass! : '');
  }
}

const LAYOUT_ICONS: Record<LibraryLayout, React.ReactNode> = {
  list: <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  small: <g fill="currentColor">{[2, 6.4, 10.8].flatMap((y) => [2, 6.4, 10.8].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="3.2" height="3.2" rx=".8" />))}</g>,
  large: <g fill="currentColor">{[2, 8.6].flatMap((y) => [2, 8.6].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="5.4" height="5.4" rx="1.2" />))}</g>,
  cards: <><rect x="2" y="2.5" width="12" height="11" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 9h12M4.5 11.2h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>,
};
const LAYOUT_OPTIONS: ReadonlyArray<SlideOption<LibraryLayout>> = LIBRARY_LAYOUTS.map((l) => ({
  id: l.id,
  label: l.label,
  content: <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>{LAYOUT_ICONS[l.id]}</svg>,
}));

/** A group's heading: folds the group under All, names the kind and its count otherwise. */
function GroupHeading({ group, collapsible, collapsed, onToggle, more, large = false, mover }: {
  group: Group;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
  more?: React.ReactNode;
  large?: boolean;
  /** The heading's transition name in the canvas. */
  mover?: string;
}) {
  const inner = <>
    {collapsible && <ChevronDownIcon className="library-chevron h-3.5 w-3.5 text-ink-faint" />}
    <span>{group.kind.label}</span>
    <span className="rounded-full bg-surface-2 px-2 text-2xs font-normal tabular-nums text-ink-faint">{group.items.length}</span>
  </>;
  const cls = `flex min-w-0 items-center gap-2 font-semibold text-ink ${large ? 'text-sm' : 'text-xs'}`;
  return (
    <h2 className={`flex items-center gap-2 px-2 pb-1 ${large ? 'pt-4' : 'pt-2'}`} data-library-mover={mover} data-library-mover-class={mover ? 'library-head' : undefined}>
      {collapsible
        ? <button type="button" className={`${cls} rounded-md hover:text-accent`} aria-expanded={!collapsed} onClick={onToggle}>{inner}</button>
        : <span className={cls}>{inner}</span>}
      {more}
    </h2>
  );
}

/** A group's body, folding away with a height animation. Folded content leaves the tab order. */
function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  return <div className="library-fold" data-open={open || undefined}><div inert={!open}>{children}</div></div>;
}

/**
 * Everything the agents have made, in one place: docs, web pages, designs,
 * diagrams, data and office files, grouped by kind. A slider at the top picks
 * All or one kind; another picks the layout. Each item names the chat it came
 * from and opens it on the Agents wall in Single agent view.
 */
export function ArtifactsView() {
  const { sessions, workspaces, refreshSessions, focusChatOnWall, profile } = useStore(useShallow((s) => ({
    sessions: s.sessions,
    workspaces: s.settings?.workspaces ?? [],
    refreshSessions: s.refreshSessions,
    focusChatOnWall: s.focusChatOnWall,
    profile: s.settings?.workProfile,
  })));
  const [showIntro, setShowIntro] = useState(() => !libraryIntroSeen());
  const closeIntro = () => { dismissLibraryIntro(); setShowIntro(false); };
  const [fromChats, setFromChats] = useState<ArtifactEntry[] | null>(null);
  // The designs sitting in each project's designs folder, whoever put them there.
  const [fromFolders, setFromFolders] = useState<ArtifactEntry[] | null>(null);
  // Every candidate chat has been read, so an empty index really means no files yet.
  const [chatsRead, setChatsRead] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ArtifactEntry | null>(null);
  // Which version of the picked design is open (its newest when null), and whether its file is shown instead of the canvas.
  const [version, setVersion] = useState<string | null>(null);
  const [asFile, setAsFile] = useState(false);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [show, setShow] = useState<Show>('all');
  const [layout, setLayout] = useState<LibraryLayout>(loadLibraryLayout);
  const [collapsed, setCollapsed] = useState<Set<ArtifactKind>>(loadCollapsedKinds);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  // Transcripts are read a few at a time from the newest chat back; cached
  // ones paint at once. Only paths are kept, never file contents.
  const candidates = useMemo(
    () => artifactCandidates(sessions.filter((s: SessionSummary) => includeCompleted || !s.archivedAt)),
    [sessions, includeCompleted],
  );
  const key = candidates.map((s) => `${s.id}:${s.updatedAt}`).join('|');
  useEffect(() => {
    let live = true;
    setChatsRead(false);
    (async () => {
      const lists: ArtifactEntry[][] = [];
      for (let i = 0; i < candidates.length; i += 6) {
        const batch = await Promise.all(candidates.slice(i, i + 6).map(async (summary) => {
          const cached = getCachedSession(summary.id);
          const full = cached && cached.updatedAt >= summary.updatedAt ? cached : await loadSession(summary.id).catch(() => null);
          return full ? sessionArtifacts(full, basePathOf(full, workspaces)) : [];
        }));
        if (!live) return;
        lists.push(...batch);
        setFromChats(mergeArtifacts(lists));
      }
      if (live && candidates.length === 0) setFromChats([]);
      if (live) setChatsRead(true);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaces]);

  // Only the folders' listings are read (names, no contents), again whenever a chat changes.
  const folders = workspaces.map((w) => `${w.id}:${w.path}`).join('|');
  useEffect(() => {
    let live = true;
    Promise.all(workspaces.map(async (w) => folderDesigns(w.name, await readDesignsFolder((path) => window.nekko.listDir(path), w.path))))
      .then((lists) => { if (live) setFromFolders(lists.flat()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, key]);

  const merged = useMemo(
    () => (fromChats || fromFolders ? withFolderDesigns(fromChats ?? [], fromFolders ?? []) : null),
    [fromChats, fromFolders],
  );
  // Which of those files are still on disk: a chat can name a file it never wrote, or one deleted since.
  // A file shows until its folder has been listed.
  const [presence, setPresence] = useState<{ checked: Set<string>; present: Set<string> } | null>(null);
  const paths = merged?.filter((e) => e.source !== 'folder').map((e) => e.path).join('\n') ?? '';
  useEffect(() => {
    if (!paths || !window.nekko?.listDir) return;
    let live = true;
    const list = paths.split('\n');
    presentPaths((path) => window.nekko.listDir(path), list).then((present) => {
      if (live) setPresence({ checked: new Set(list.map((p) => p.toLowerCase())), present });
    });
    return () => { live = false; };
  }, [paths]);
  const entries = useMemo(() => {
    if (!merged) return null;
    const gone = (e: ArtifactEntry) => !!presence && presence.checked.has(e.path.toLowerCase()) && !presence.present.has(e.path.toLowerCase());
    return groupDesignVersions(merged.filter((e) => !gone(e)));
  }, [merged, presence]);
  const indexed = chatsRead && fromFolders !== null;

  // The kinds that have files lead the slider; the setup answer's kind comes first.
  const kinds = useMemo(() => orderForProfile(groupArtifacts(entries ?? []), profile), [entries, profile]);
  const groups = useMemo(() => orderForProfile(groupArtifacts(entries ?? [], query), profile), [entries, query, profile]);
  const total = entries?.length ?? 0;
  // A kind whose last file left (a chat was archived away) falls back to All.
  const current: Show = show === 'all' || kinds.some((g) => g.kind.id === show) ? show : 'all';
  const all = current === 'all';
  const shown = all ? groups : groups.filter((g) => g.kind.id === current);
  const isFolded = (kind: ArtifactKind) => all && collapsed.has(kind);
  const listWide = layout === 'list' && !selected;
  const browsing = !selected && layout !== 'list' && shown.length > 0;

  const typeOptions = useMemo<ReadonlyArray<SlideOption<Show>>>(() => [
    { id: 'all', label: `All, ${total}`, content: <>All <span className="slide-toggle-count">{total}</span></> },
    ...kinds.map((g) => ({ id: g.kind.id, label: `${g.kind.label}, ${g.items.length}`, content: <>{g.kind.label} <span className="slide-toggle-count">{g.items.length}</span></> })),
  ], [kinds, total]);

  // A stable number per file for its transition names, so a tile morphs into its own new place.
  const ids = useRef(new Map<string, number>());
  const idOf = (path: string) => {
    let n = ids.current.get(path);
    if (n === undefined) { n = ids.current.size; ids.current.set(path, n); }
    return n;
  };

  // Moving between the preview layouts leaves the list alone; anything touching List, or the kind shown, changes it.
  const pickLayout = (next: LibraryLayout) => { if (next !== layout) transition(() => { setLayout(next); saveLibraryLayout(next); }, next === 'list' || layout === 'list'); };
  const pickShow = (next: Show) => { if (next !== current) transition(() => setShow(next), true); };
  const toggle = (kind: ArtifactKind) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(kind)) next.add(kind);
    saveCollapsedKinds(next);
    return next;
  });
  // In List the list gives way to the preview, so the change is animated; elsewhere it is a swap.
  const pick = (e: ArtifactEntry | null) => { setSelected(e); setVersion(null); setAsFile(false); };
  const select = (e: ArtifactEntry | null) => (layout === 'list' ? transition(() => pick(e), true) : pick(e));
  // Back to Library from a file: Escape outside a field, or the mouse's back button.
  const back = useRef(() => {});
  back.current = () => { if (selected && !showIntro) select(null); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || !t || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // A dialog over the page (the palette, a menu) takes its own Escape.
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      back.current();
    };
    const mouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); back.current(); } };
    window.addEventListener('keydown', key);
    window.addEventListener('mouseup', mouse);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mouseup', mouse); };
  }, []);
  const openPath = selected ? version ?? selected.path : '';
  const onCanvas = !!selected && selected.kind === 'design' && isHtml(openPath);

  const row = (e: ArtifactEntry) => {
    const active = selected?.path === e.path;
    return (
      <div key={e.path} role="listitem" className={`group rounded-lg ${active ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}>
        <button type="button" data-artifact-row className="flex w-full min-w-0 items-center gap-3 px-2 py-1 text-left" onClick={() => select(e)} title={e.path}>
          <ArtifactPreview kind={e.kind} path={e.path} ext={extOf(e.filename)} icon className="h-7 w-7 shrink-0 rounded-md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-ink">{e.title}</span>
            {!listWide && <span className="block truncate text-2xs text-ink-faint">{fromAndWhen(e)}</span>}
          </span>
          {listWide && <>
            <span className="hidden w-48 truncate font-mono text-2xs text-ink-faint lg:block">{e.filename}</span>
            <span className="hidden w-56 truncate text-2xs text-ink-faint sm:block">{cameFrom(e)}</span>
            <span className="w-16 shrink-0 text-right text-2xs tabular-nums text-ink-faint">{when(e.at)}</span>
          </>}
        </button>
      </div>
    );
  };

  const tile = (e: ArtifactEntry) => {
    const n = idOf(e.path);
    return (
    <div key={e.path} role="listitem" className="library-tile" data-library-tile>
      <button type="button" className="library-tile-main" onClick={() => select(e)} title={e.path}>
        <TilePreview kind={e.kind} path={e.path} ext={extOf(e.filename)} className="library-tile-preview" mover={`library-preview-${n}`} />
        <span className="library-tile-label" data-library-mover={`library-label-${n}`} data-library-mover-class="library-label">
          <span className="library-tile-title">{e.title}</span>
          <span className="library-tile-meta">{fromAndWhen(e)}</span>
        </span>
      </button>
      {layout === 'cards' && (
        <div className="library-tile-actions">
          {e.sessionId && (
            <button type="button" className="btn btn-ghost gap-1.5 px-2 py-0.5 text-2xs text-ink-soft" onClick={() => focusChatOnWall(e.sessionId)} title={`Open “${e.sessionTitle}” on the Agents wall in Single agent view`}>
              <FocusLayoutIcon className="h-3 w-3" /> Open chat
            </button>
          )}
          <button type="button" className="btn btn-ghost gap-1.5 px-2 py-0.5 text-2xs text-ink-soft" onClick={() => window.nekko.openPath(e.path)} title="Open with the system's default app">
            <ExternalIcon className="h-3 w-3" /> Open file
          </button>
        </div>
      )}
    </div>
    );
  };

  // No files at all yet: the illustrated placeholder fills the page in every layout.
  const noFiles = indexed && total === 0;
  const empty = query && entries && shown.length === 0 ? 'Nothing matches.' : null;

  const placeholder = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center" data-library-empty>
      <div className="w-full max-w-xs"><LibraryArtwork /></div>
      <h2 className="text-xl font-semibold">What your agents made</h2>
      <p className="max-w-sm text-sm text-ink-faint">
        Nothing here yet. Reports, pages, designs and diagrams your agents write or link to in a chat show up here, grouped by kind.
      </p>
      <p className="mt-2 max-w-sm rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-soft">
        Try asking an agent: “Create a one-page report and link the file in your reply.”
      </p>
      {!includeCompleted && (
        <button type="button" className="btn btn-ghost mt-1 text-xs" onClick={() => setIncludeCompleted(true)}>Include completed chats</button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-artifacts-view data-library-layout={layout}>
      {showIntro && <LibraryIntro onClose={closeIntro} />}
      <header className={`${selected ? 'hidden md:flex' : 'flex'} min-w-0 items-center gap-3 border-b border-line px-4 py-2`}>
        {!hasAppChrome && <h1 className="view-title shrink-0">Library</h1>}
        {!noFiles && (
          <div className="library-types min-w-0 overflow-x-auto">
            <SlideToggle label="Show" options={typeOptions} value={current} onChange={pickShow} transitionName="library-show" />
          </div>
        )}
        <span className="ml-auto shrink-0 text-2xs tabular-nums text-ink-faint">{entries ? `${total} item${total === 1 ? '' : 's'}` : 'Reading chats…'}</span>
        <button type="button" className="btn btn-ghost shrink-0 px-3 py-1 text-xs" onClick={() => setShowIntro(true)}>Library guide</button>
        {!noFiles && <SlideToggle label="Layout" options={LAYOUT_OPTIONS} value={layout} onChange={pickLayout} iconOnly className="hidden shrink-0 md:inline-flex" transitionName="library-layout" />}
      </header>

      {noFiles ? placeholder : <div className="flex min-h-0 flex-1">
        <aside className={`library-list ${selected ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col ${listWide ? '' : 'md:w-[340px] md:border-r md:border-line'}`}>
          <div className={`space-y-2 px-3 pb-2 pt-3 ${listWide ? 'md:px-5' : ''}`}>
            <input className="input rounded-lg px-3 py-1 text-xs" placeholder="Filter by name, file or chat…" aria-label="Filter Library" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="flex items-center gap-2 text-2xs text-ink-faint">
              <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} /> Include completed chats
            </label>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto px-2 pb-3 ${listWide ? 'md:px-4' : ''}`} role="list" aria-label="Library files">
            {empty && <p className="px-3 py-2 text-xs text-ink-faint">{empty}</p>}
            {shown.map((g) => (
              <section key={g.kind.id} className="mb-1" data-artifact-kind={g.kind.id} aria-label={g.kind.label}>
                <GroupHeading group={g} collapsible={all} collapsed={isFolded(g.kind.id)} onToggle={() => toggle(g.kind.id)} />
                <Fold open={!isFolded(g.kind.id)}>{g.items.map(row)}</Fold>
              </section>
            ))}
          </div>
        </aside>

        <section className={`${listWide ? 'hidden' : selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                <button type="button" className="btn btn-ghost shrink-0 gap-1 px-2 py-1 text-xs" data-library-back aria-label="Back to Library" title="Back to Library (Esc)" onClick={() => select(null)}>
                  <ChevronIcon className="h-3.5 w-3.5 rotate-180" /> Library
                </button>
                {/* At least 10rem for the name: on a narrow window the actions wrap below instead. */}
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-semibold">{selected.title}</p>
                  <p className="truncate font-mono text-2xs text-ink-faint" title={openPath}>{openPath}</p>
                </div>
                {selected.sessionId && (
                  <button type="button" className="btn btn-primary gap-2 py-1 text-xs" onClick={() => focusChatOnWall(selected.sessionId)} title={`Open “${selected.sessionTitle}” on the Agents wall in Single agent view`}>
                    <FocusLayoutIcon className="h-3.5 w-3.5" /> Open chat
                  </button>
                )}
                <button type="button" className={`btn ${selected.sessionId ? 'btn-outline' : 'btn-primary'} gap-2 py-1 text-xs`} onClick={() => window.nekko.openPath(openPath)} title="Open with the system's default app">
                  <ExternalIcon className="h-3.5 w-3.5" /> Open file
                </button>
                {onCanvas && asFile && <button type="button" className="btn btn-ghost py-1 text-xs" data-design-back onClick={() => setAsFile(false)} title="Show the design on its canvas again">Canvas</button>}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden" key={onCanvas && !asFile ? `canvas:${selected.path}` : `file:${openPath}`}>
                {onCanvas && !asFile
                  ? <DesignCanvas path={openPath} title={selected.title} versions={selected.versions} onVersion={setVersion} onSource={() => setAsFile(true)} />
                  : <FilePane path={openPath} />}
              </div>
            </>
          ) : browsing ? (
            <div className="library-canvas min-h-0 flex-1 overflow-y-auto px-5 pb-8" data-library-canvas>
              {shown.map((g) => {
                const limit = all ? PREVIEW_LIMIT[layout as keyof typeof PREVIEW_LIMIT] : Infinity;
                const more = all && g.items.length > limit
                  ? <button type="button" className="ml-auto shrink-0 rounded-md px-1 text-2xs font-medium text-accent hover:underline" onClick={() => pickShow(g.kind.id)}>See all {g.items.length}</button>
                  : undefined;
                return (
                  <section key={g.kind.id} data-library-group={g.kind.id} aria-label={g.kind.label}>
                    <GroupHeading group={g} collapsible={all} collapsed={isFolded(g.kind.id)} onToggle={() => toggle(g.kind.id)} more={more} large mover={`library-head-${g.kind.id}`} />
                    <Fold open={!isFolded(g.kind.id)}>
                      <div className="library-tiles" role="list" aria-label={`${g.kind.label} previews`}>{g.items.slice(0, limit).map(tile)}</div>
                    </Fold>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <div className="w-full max-w-xs"><LibraryArtwork /></div>
              <h2 className="text-xl font-semibold">What your agents made</h2>
              <p className="max-w-sm text-sm text-ink-faint">
                Reports, pages, designs and diagrams from every chat, grouped by kind. Pick one to preview it, or open the chat it came from in Single agent view.
              </p>
            </div>
          )}
        </section>
      </div>}
    </div>
  );
}
