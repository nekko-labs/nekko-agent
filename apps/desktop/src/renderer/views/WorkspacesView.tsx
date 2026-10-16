import { confirmDeletion } from '../components/DeleteConfirmation.js';
import { AgentPanelControls } from '../components/AgentPanelControls.js';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, SessionSummary, TerminalInfo, WorkspaceFolder } from '@nekko-agent/shared';
import { AUTO_MODEL_ID, archiveDaysLeft, archiveDeletesAt, parsePrUrl } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type Workspace } from '../store.js';
import { PaneVisibleContext, usePaneVisible } from '../paneVisibility.js';
import { afterPaint } from '../afterPaint.js';
import { allPanes, isSplit, type Direction, type WbNode, type WbPane } from '../layout.js';
import { ChatPane } from '../components/ChatPane.js';
import { TerminalPane } from '../components/TerminalPane.js';
import { FilePane } from '../components/FilePane.js';
import { BrowserPane } from '../components/BrowserPane.js';
import { HypergatePane } from '../components/HypergatePane.js';
import { DiffPane } from '../components/DiffPane.js';
import { PrPane } from '../components/PrCard.js';
import { ContextInspector } from '../components/ContextInspector.js';
import { ExplorerPane } from '../components/ExplorerPane.js';
import { PaneFrame } from '../components/PaneFrame.js';
import { Divider } from '../components/Divider.js';
import { runningSessionIds } from '../liveRuns.js';
import { StatusIcon, WorkspaceCard, type AgentStatus } from '../components/WorkspaceCard.js';
import { CheckIcon, ChatIcon, PhotoIcon, TerminalIcon, PlusIcon, FileIcon, FolderIcon, ExternalIcon, PanelIcon, ShieldIcon, PanelLeftIcon, PanelSwapIcon } from '../icons.js';
import { SHORTCUTS } from '../shortcuts.js';
import { NekkoAvatar } from '../components/Mascot.js';
import { COMPLETION_ROW_ATTR, completeWithExit, findCompletionRow } from '../completionExit.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { ModelPicker } from '../components/agent-console/ModelPicker.js';
import { selectWorkspaceRows } from './workspaceSelection.js';
import { unopenedChats } from './unopenedChats.js';
import { completedDate, completedInGroup } from './completedChats.js';
import { leftGroup, moveGroupBefore } from './groupDrag.js';

/** Short label for a window's title strip. */
function paneTitle(pane: WbPane, sessions: SessionSummary[], terminals: TerminalInfo[]): string {
  if (pane.kind === 'chat') return sessions.find((s) => s.id === pane.refId)?.title ?? 'Chat';
  if (pane.kind === 'terminal') return terminals.find((x) => x.id === pane.refId)?.title || (pane.refId.startsWith('agent_') ? 'Agent commands' : 'Terminal');
  if (pane.kind === 'browser') {
    try { return new URL(pane.refId).host || 'Browser'; } catch { return 'Browser'; }
  }
  if (pane.kind === 'hypergate') return 'Hypergate';
  if (pane.kind === 'diff') return 'Changes';
  if (pane.kind === 'pr') {
    const p = parsePrUrl(pane.refId);
    return p ? `PR #${p.number}` : 'Pull request';
  }
  // A file or an explorer: the last segment of the path, or the prompt an
  // explorer that hasn't been pointed anywhere yet is showing.
  if (!pane.refId) return 'Files';
  return pane.refId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pane.refId;
}

/** Icon for a window by kind. */
function PaneIcon({ kind }: { kind: WbPane['kind'] }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-ink-faint';
  if (kind === 'terminal') return <TerminalIcon className={cls} />;
  if (kind === 'browser') return <ExternalIcon className={cls} />;
  // The one window that is a product rather than a document, so it keeps the
  // accent its card in Settings uses instead of the muted grey.
  if (kind === 'hypergate') return <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-accent" />;
  if (kind === 'pr') return <span className="w-3.5 shrink-0 text-center text-[12px] leading-none text-ink-faint">⑂</span>;
  if (kind === 'files') return <FolderIcon className={cls} />;
  if (kind === 'file' || kind === 'diff') return <FileIcon className={cls} />;
  return <ChatIcon className={cls} />;
}

/**
 * Render a window's body by kind.
 *
 * A workspace kept mounted behind the one on screen (see MOUNTED_WORKSPACES)
 * keeps only its chats alive: terminals, browsers and the rest mount again when
 * it is shown, as they always have, rather than running at zero size unseen.
 */
function PaneBody({ pane, hidden }: { pane: WbPane; hidden: boolean }) {
  if (hidden && pane.kind !== 'chat') return null;
  switch (pane.kind) {
    case 'chat': return <ChatPane key={pane.refId} sessionId={pane.refId} />;
    case 'terminal': return <TerminalPane key={pane.refId} terminalId={pane.refId} />;
    case 'file': return <FilePane key={pane.refId} path={pane.refId} />;
    case 'files': return <ExplorerPane key={pane.id} paneId={pane.id} root={pane.refId} />;
    case 'browser': return <BrowserPane key={pane.refId} url={pane.refId} />;
    case 'hypergate': return <HypergatePane key={pane.refId} url={pane.refId} />;
    case 'diff': return <DiffPane key={pane.refId} sessionId={pane.refId} />;
    case 'pr': return <PrPane key={pane.refId} url={pane.refId} />;
    default: return null;
  }
}

/**
 * Workspaces: the left sidebar lists them, the middle shows the one you picked.
 *
 * A workspace is a whole arrangement of windows rather than a tab — its chat,
 * the file the agent touched, a terminal, a browser, all on screen together —
 * and each card in the sidebar says what its agent is running without being
 * opened. There is no tab strip anywhere: windows are added on a side of an
 * existing one, dragged between sides, and resized by their dividers.
 */

/**
 * Workspaces kept mounted: the one on screen and the ones used just before it.
 * Switching back to one of these is a visibility flip, not a rebuild; the rest
 * are unmounted, so the warm set has a fixed ceiling.
 */
const MOUNTED_WORKSPACES = 3;

/** Something being dragged in the sidebar (a project or a workspace). */
type DragItem = { kind: 'project' | 'workspace'; id: string; ws: string | undefined };

/**
 * One active agent in a sidebar group: an open workspace, or a chat that is
 * active but has no window open (`w` null). `key` is the workspace id, or
 * `CHAT_KEY` + the chat id for the latter.
 */
type Entry = { key: string; w: Workspace | null; s: SessionSummary | null; t: TerminalInfo | null };
const CHAT_KEY = 'chat:';

/**
 * The workspace list's width, drag-resizable between a card's minimum and the
 * point where the list would crowd the windows it sits beside. Remembered like
 * the plan rail's open state: a per-window preference, not a setting.
 */
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 480;
const SIDEBAR_DEFAULT_W = 256;
const SIDEBAR_W_KEY = 'nekko.wsSidebarWidth';

function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(px)));
}

function readSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampSidebarWidth(saved);
  } catch { /* private mode */ }
  return SIDEBAR_DEFAULT_W;
}

/** One colored row of the create menu: a tinted icon tile and a label. */
function CreateRow({
  tone,
  icon,
  label,
  title,
  onClick,
}: {
  tone: string;
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left"
      style={{ '--row-tone': tone } as React.CSSProperties}
      title={title}
      onClick={onClick}
    >
      <span className="create-tile">{icon}</span>
      <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{label}</span>
    </button>
  );
}

/**
 * Sort by manual drag order when set, else by a fallback (recency for chats,
 * age for terminals). Manually-ordered items sort above never-dragged ones.
 */
function bySidebarOrder<T extends { order?: number }>(fallback: (x: T) => number) {
  return (a: T, b: T) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return fallback(a) - fallback(b);
  };
}

/** The project folder a workspace files under, read off whatever it is about. */
function projectOfWorkspace(w: Workspace, sessions: SessionSummary[], terminals: TerminalInfo[]): string | undefined {
  if (w.anchor.kind === 'chat') return sessions.find((s) => s.id === w.anchor.refId)?.workspaceId;
  if (w.anchor.kind === 'terminal') return terminals.find((t) => t.id === w.anchor.refId)?.workspaceId;
  return undefined;
}

/**
 * Fold an agent event into the per-session status (undefined = idle).
 *
 * A question or an approval parks the turn on you, so it reads as "needs your
 * input" until it is answered. While parked the run keeps streaming nothing, but
 * a stray token or step must not quietly flip the card back to "working" and
 * hide the ?, so only the events that end the wait (an answer, a tool result,
 * done, error) move it on. `undefined` keeps whatever the card showed.
 */
export function statusFromEvent(type: AgentEvent['type'], prev?: AgentStatus): AgentStatus | null | undefined {
  switch (type) {
    case 'tool_approval_required':
    case 'question': return 'input';
    case 'question_resolved':
    case 'tool_result': return 'working';
    case 'error': return 'error';
    case 'done': return null;
    default: return prev === 'input' ? undefined : 'working';
  }
}

/** How the Agents tab lays out its panel of agent cards. */
export type AgentPanelOrientation = 'vertical' | 'horizontal';

type SidebarActions = {
  onOpenChat: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  selectedId: string | null;
  onCreate: (kind: 'chat' | 'image' | 'terminal', projectId?: string, shell?: string) => Promise<void>;
  /** A column beside the wall, or a row of cards above it. */
  orientation?: AgentPanelOrientation;
  onOrientation?: (orientation: AgentPanelOrientation) => void;
  /** Hide the panel; the Agents toolbar offers it back. */
  onClosePanel?: () => void;
};

export function AgentSidebar(props: SidebarActions) {
  return <WorkspacesView sidebarOnly {...props} />;
}

export function WorkspacesView({ sidebarOnly = false, onOpenChat, onOpenTerminal, selectedId, onCreate, orientation = 'vertical', onOrientation, onClosePanel }: Partial<SidebarActions> & { sidebarOnly?: boolean } = {}) {
  const horizontal = sidebarOnly && orientation === 'horizontal';
  const {
    sessions, terminals, workspaces, activeWorkspaceId, settings, activeSessionId,
    refreshSessions, refreshTerminals, openChatPane, openTerminalPane, newTerminal: storeNewTerminal, newTerminalWorkspace: storeNewTerminalWorkspace,
    setActiveWorkspace, newChat: storeNewChat,
    reorderWorkspaces, layoutChats, layoutTerminals, contextPanelOpen,
    archiveWorkspace, archiveChat, archiveOpen, archivedViewId,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      terminals: s.terminals,
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      settings: s.settings,
      activeSessionId: s.activeSessionId,
      refreshSessions: s.refreshSessions,
      refreshTerminals: s.refreshTerminals,
      openChatPane: s.openChatPane,
      openTerminalPane: s.openTerminalPane,
      newTerminal: s.newTerminal,
      newTerminalWorkspace: s.newTerminalWorkspace,
      setActiveWorkspace: s.setActiveWorkspace,
      newChat: s.newChat,
      reorderWorkspaces: s.reorderWorkspaces,
      layoutChats: s.layoutChats,
      layoutTerminals: s.layoutTerminals,
      contextPanelOpen: s.contextPanelOpen,
      archiveWorkspace: s.archiveWorkspace,
      archiveChat: s.archiveChat,
      archiveOpen: s.archiveOpen,
      archivedViewId: s.archivedViewId,
    })),
  );
  const newChat = (projectId?: string) => sidebarOnly && onCreate ? onCreate('chat', projectId ?? activeProjectId()) : storeNewChat(projectId);
  const activeProjectId = () => useStore.getState().activeProjectId ?? undefined;
  const newTerminal = (projectId?: string) => sidebarOnly && onCreate ? onCreate('terminal', projectId) : storeNewTerminal(projectId);
  const newTerminalWorkspace = (projectId?: string, shell?: string) => sidebarOnly && onCreate ? onCreate('terminal', projectId ?? activeProjectId(), shell) : storeNewTerminalWorkspace(projectId, shell);
  const newImageChat = () => sidebarOnly && onCreate ? onCreate('image', activeProjectId()) : useStore.getState().newImageChat('');
  const pendingProjectActions = useRef(new Set<string>());
  // Set while a group header's + or terminal button is pressed, so the row's
  // project drag does not start under it and eat the click.
  const pressingGroupAction = useRef(false);
  useEffect(() => {
    const release = () => { pressingGroupAction.current = false; };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('dragend', release, true);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('dragend', release, true);
    };
  }, []);
  const [pendingProjects, setPendingProjects] = useState<string[]>([]);
  const createInProject = async (kind: 'chat' | 'terminal', projectId: string | undefined, name: string) => {
    const key = projectId ?? '__none';
    if (pendingProjectActions.current.has(key)) return;
    pendingProjectActions.current.add(key);
    setPendingProjects([...pendingProjectActions.current]);
    try {
      if (kind === 'chat') await newChat(projectId);
      else await newTerminal(projectId);
      setMobileNav(false);
    } catch (error) {
      useStore.getState().pushToast('error', `Could not ${kind === 'chat' ? 'create an agent' : 'open a terminal'} in ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pendingProjectActions.current.delete(key);
      setPendingProjects([...pendingProjectActions.current]);
    }
  };
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{x: number; y: number; ids: string[]; model?: boolean} | null>(null);
  const selectRow = (e: React.MouseEvent, id: string) => {
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) { setSelected([]); anchor.current = id; return false; }
    e.preventDefault(); e.stopPropagation();
    const order = buckets.filter(b => !collapsed.has(b.key)).flatMap(b => bucketEntries(b.key).flatMap(e => e.s ? [e.s.id] : []));
    setSelected(prev => selectWorkspaceRows(prev, order, id, anchor.current, e.shiftKey));
    if (!e.shiftKey) anchor.current = id;
    return true;
  };
  const contextRow = (e: React.MouseEvent, id: string) => { e.preventDefault(); e.stopPropagation(); const ids = selected.includes(id) ? selected.filter(x => sessions.some(s => s.id === x)) : [id]; setSelected(ids); setMenu({x:e.clientX,y:e.clientY,ids}); };
  const runAction = async (action: 'complete' | 'delete' | 'stop' | 'continue', ids: string[]) => {
    setMenu(null);
    if (action === 'delete' && !await confirmDeletion('Permanently delete ' + ids.length + ' chat(s)? This cannot be undone.')) return;
    await Promise.all(ids.map(async (id) => {
      try {
        if (action === 'complete') await completeWithExit(findCompletionRow(id), async () => { await archiveChat(id); return useStore.getState().sessions.some((s) => s.id === id && s.archivedAt); });
        if (action === 'delete') await useStore.getState().deleteChatForever(id, true);
        if (action === 'stop' && statuses.has(id)) await window.nekko.abortChat(id);
        if (action === 'continue' && !statuses.has(id)) { const s = await window.nekko.getSession(id); if (!s?.providerId || !s.modelId || s.autoModel) throw new Error('Choose a specific model before continuing this chat.'); if (!s.messages.some(m => m.role === 'user')) throw new Error('This chat has no prompt to continue.'); await window.nekko.sendChat({sessionId:id,providerId:s.providerId,modelId:s.modelId,text:'',resume:true}); }
      } catch(e) { useStore.getState().pushToast('error', id + ': ' + String(e)); }
    }));
    await refreshSessions(); setSelected([]);
  };
  /** A completed chat is open in the read-only reader. */
  const reading = archiveOpen && !!archivedViewId;

  // Seeded from the app-wide fold of agent events, so a chat already working
  // is marked so on the first frame; the host confirms on mount for runs that
  // began before this window did.
  const [statuses, setStatuses] = useState<Map<string, AgentStatus>>(() => new Map(runningSessionIds().map((id) => [id, 'working' as AgentStatus])));
  useEffect(() => {
    window.nekko.runningSessions().then((ids) => setStatuses((prev) => {
      const missing = ids.filter((id) => !prev.has(id));
      if (missing.length === 0) return prev;
      const m = new Map(prev);
      for (const id of missing) m.set(id, 'working');
      return m;
    })).catch(() => {});
    // A question or approval asked before this view mounted (a view switch, a
    // reload) has already sent its event; the host still holds it, so ask.
    window.nekko.pendingInput().then((pending) => setStatuses((prev) => {
      const waiting = Object.keys(pending ?? {}).filter((id) => prev.get(id) !== 'input');
      if (waiting.length === 0) return prev;
      const m = new Map(prev);
      for (const id of waiting) m.set(id, 'input');
      return m;
    })).catch(() => {});
  }, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Groups whose completed chats are expanded under their active ones. */
  const completionTipSessionId = useStore((s) => s.completionTipSessionId);
  const showTips = useStore((s) => s.settings?.showTips !== false);
  const [showCompleted, setShowCompleted] = useState<Set<string>>(new Set());
  const [sidebarW, setSidebarW] = useState(readSidebarWidth);
  const saveSidebarW = (px: number) => {
    const w = clampSidebarWidth(px);
    setSidebarW(w);
    try { localStorage.setItem(SIDEBAR_W_KEY, String(w)); } catch { /* private mode */ }
  };
  const [mobileNav, setMobileNav] = useState(false);
  const completionDestinationRef = useRef<HTMLButtonElement>(null);
  // Reveal the existing destination without expanding completed chats or taking focus.
  useEffect(() => {
    if (!sidebarOnly || !showTips || !completionTipSessionId) return;
    const completed = sessions.find((s) => s.id === completionTipSessionId && s.archivedAt);
    if (!completed) return;
    const group = chatGroupOf(completed);
    setCollapsed((previous) => {
      if (!previous.has(group)) return previous;
      const next = new Set(previous); next.delete(group); return next;
    });
    if (!horizontal && window.innerWidth < 768) setMobileNav(true);
  }, [completionTipSessionId, sidebarOnly, showTips, horizontal, sessions]);
  useLayoutEffect(() => {
    if (!sidebarOnly || !showTips || !completionTipSessionId) return;
    const frame = requestAnimationFrame(() => {
      completionDestinationRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [completionTipSessionId, sidebarOnly, showTips, mobileNav, collapsed]);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const newMenuPopRef = useRef<HTMLDivElement>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement>(null);
  const newMenuTimer = useRef<number>(0);
  // The menu renders in a portal at the document root, positioned under the +.
  // The panel clips its overflow and the wall's windows stack above it, so a
  // menu drawn inside the panel was cut off or hidden behind them.
  const [newMenuPos, setNewMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!newMenuOpen) return;
    const place = () => {
      const r = newMenuButtonRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 256;
      setNewMenuPos({ top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [newMenuOpen]);

  useEffect(() => { refreshTerminals(); }, [refreshTerminals]);

  // Close the "+" create menu on an outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (newMenuRef.current && !newMenuRef.current.contains(target) && !newMenuPopRef.current?.contains(target)) setNewMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => () => window.clearTimeout(newMenuTimer.current), []);

  /**
   * The create menu opens on hover, like the split compass does: starting a new
   * agent is the most common thing anyone does here, and it should not cost a
   * click to find out what the "+" offers. Leaving starts a short grace period
   * instead of closing outright, so the gap between the button and the menu is
   * crossable with an ordinary hand.
   */
  const openNewMenu = () => {
    window.clearTimeout(newMenuTimer.current);
    setNewMenuOpen(true);
  };
  const closeNewMenuSoon = () => {
    window.clearTimeout(newMenuTimer.current);
    newMenuTimer.current = window.setTimeout(() => setNewMenuOpen(false), 220);
  };
  /**
   * The row scrolls sideways, but a mouse wheel only scrolls down: turn the
   * wheel's vertical travel into horizontal scrolling while the row can move.
   */
  const scrollRowWithWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  };
  const closeNewMenu = () => {
    window.clearTimeout(newMenuTimer.current);
    setNewMenuOpen(false);
  };

  // Open the active session as a workspace if there are none (e.g. arriving
  // from the Command Center or command palette).
  useEffect(() => {
    if (!sidebarOnly && workspaces.length === 0 && activeSessionId) openChatPane(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive each session's status (working / needs-input / error / idle) from its
  // agent events for the sidebar cards + window strips, and surface freshly
  // spawned sub-agents by refreshing the list when an unknown id appears.
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      setStatuses((prev) => {
        const next = statusFromEvent(e.type, prev.get(e.sessionId));
        // Most events (every token) leave the status as it was; keeping the
        // same Map then means the view, and every pane in it, does not re-render.
        if (next === undefined || (next === null ? !prev.has(e.sessionId) : prev.get(e.sessionId) === next)) return prev;
        const m = new Map(prev);
        if (next === null) m.delete(e.sessionId);
        else m.set(e.sessionId, next);
        return m;
      });
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // Populate PR badges for chats that reference a PR in their transcript. Only
  // sessions with a detected PR URL and no cached state get a (host-cached)
  // fetch, bounded so we never shell out to gh for a whole list at once.
  useEffect(() => {
    const loaded = useStore.getState().prsBySession;
    sessions
      .filter((s) => !(s.id in loaded) && s.prUrls.length > 0)
      .slice(0, 8)
      .forEach((s) => { void useStore.getState().refreshSessionPrs(s.id); });
  }, [sessions]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of sessions) if (s.parentSessionId && (statuses.has(s.id) || !s.lastReplyText)) {
      const arr = m.get(s.parentSessionId) ?? [];
      arr.push(s);
      m.set(s.parentSessionId, arr);
    }
    return m;
  }, [sessions, statuses]);

  // Closing a workspace only closes its windows, not the saved conversation.
  // Keep those chats reachable without reopening every transcript at startup.
  const savedChats = useMemo(() => {
    const visibleChildIds = new Set(workspaces.flatMap((w) => w.anchor.kind === 'chat'
      ? (childrenOf.get(w.anchor.refId) ?? []).map((s) => s.id) : []));
    return unopenedChats(sessions, workspaces, visibleChildIds);
  }, [sessions, workspaces, childrenOf]);

  const toggleCollapse = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const sessionOf = (w: Workspace) =>
    (w.anchor.kind === 'chat' ? sessions.find((s) => s.id === w.anchor.refId) : undefined) ?? null;
  const terminalOf = (w: Workspace) =>
    (w.anchor.kind === 'terminal' ? terminals.find((t) => t.id === w.anchor.refId) : undefined) ?? null;

  const projectOf = (w: Workspace): string => projectOfWorkspace(w, sessions, terminals) ?? '__none';

  // Project buckets: a "General" bucket for project-less work (kept at the top,
  // hidden when empty), then one bucket per project folder.
  const buckets: Array<{ ws?: WorkspaceFolder; key: string; name: string }> = [
    { key: '__none', name: 'General' },
    ...(settings?.workspaces ?? []).map((w) => ({ ws: w, key: w.id, name: w.name })),
  ];

  const chatGroupOf = (s: SessionSummary): string =>
    settings?.workspaces.some((p) => p.id === s.workspaceId) ? (s.workspaceId as string) : '__none';

  /**
   * Every active agent in a bucket: open workspaces and chats that are not
   * open in one alike, in the order their chats or terminals were dragged
   * into. A chat stays in this list until it is completed; closing its
   * windows does not demote it to a second-class list.
   */
  const bucketEntries = (key: string): Entry[] =>
    [
      ...workspaces.filter((w) => projectOf(w) === key).map((w): Entry => ({ key: w.id, w, s: sessionOf(w), t: terminalOf(w) })),
      ...savedChats.filter((s) => chatGroupOf(s) === key).map((s): Entry => ({ key: CHAT_KEY + s.id, w: null, s, t: null })),
    ]
      .map((e) => ({ e, order: e.s?.order ?? e.t?.order, at: e.s ? -e.s.updatedAt : e.t?.createdAt ?? 0 }))
      .sort(bySidebarOrder<{ order?: number; at: number }>((x) => x.at))
      .map((x) => x.e);
  const findEntry = (key: string): Entry | null =>
    buckets.flatMap((b) => bucketEntries(b.key)).find((e) => e.key === key) ?? null;

  // --- Sidebar drag-and-drop (reorder projects; reorder / re-file workspaces) ---
  const startDrag = (e: React.DragEvent, item: DragItem) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    setDrag(item);
  };
  const endDrag = () => { setDrag(null); setDropTarget(null); };
  const overTarget = (e: React.DragEvent, key: string, accept: (d: DragItem) => boolean) => {
    if (!drag || !accept(drag)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== key) setDropTarget(key);
  };

  type Bucket = { ws?: WorkspaceFolder; key: string; name: string };

  /**
   * Persist a bucket's order after a drag. Chats and terminals are ordered by
   * separate host calls, so one drop writes the sequence of each kind it moved.
   */
  const persistOrder = (b: Bucket, ordered: Entry[], moved: Entry | null) => {
    const chats = ordered.flatMap((e) => (e.s ? [e.s] : []));
    const terms = ordered.flatMap((e) => (e.t ? [e.t] : []));
    void layoutChats(b.ws?.id, chats.map((c) => c.id), moved?.s?.id ?? null);
    void layoutTerminals(b.ws?.id, terms.map((t) => t.id), moved?.t?.id ?? null);
  };

  const dropOnBucket = (b: Bucket) => {
    const d = drag;
    if (!d) return endDrag();
    if (d.kind === 'project') {
      const ids = (settings?.workspaces ?? []).map((w) => w.id);
      const ordered = moveGroupBefore(ids, d.id, b.ws ? b.key : null);
      if (ordered !== ids) void reorderWorkspaces(ordered).catch((e: Error) => useStore.getState().pushToast('error', e.message));
    } else {
      const moved = findEntry(d.id);
      const ordered = [...bucketEntries(b.key).filter((e) => e.key !== d.id), ...(moved ? [moved] : [])];
      persistOrder(b, ordered, d.ws !== b.ws?.id ? moved : null);
    }
    endDrag();
  };

  const dropBeforeCard = (b: Bucket, targetKey: string) => {
    const d = drag;
    if (!d || d.kind !== 'workspace' || targetKey === d.id) return endDrag();
    const moved = findEntry(d.id);
    const rest = bucketEntries(b.key).filter((e) => e.key !== d.id);
    const i = rest.findIndex((e) => e.key === targetKey);
    if (moved) rest.splice(i < 0 ? rest.length : i, 0, moved);
    persistOrder(b, rest, d.ws !== b.ws?.id ? moved : null);
    endDrag();
  };

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[workspaces.length - 1] ?? null;

  // Most recently shown first. Worked out during render, so the frame that
  // switches is the frame that shows the new workspace.
  const recent = useRef<string[]>([]);
  // A workspace that just dropped out of the warm set is unmounted after the
  // switch has painted, not during it.
  const leaving = useRef<string[]>([]);
  const [, settle] = useState(0);
  if (active && recent.current[0] !== active.id) {
    const next = [active.id, ...recent.current.filter((id) => id !== active.id)];
    leaving.current = [...leaving.current, ...next.slice(MOUNTED_WORKSPACES)].filter((id) => id !== active.id);
    recent.current = next.slice(0, MOUNTED_WORKSPACES);
  }
  useEffect(() => {
    if (!leaving.current.length) return;
    return afterPaint(() => {
      leaving.current = [];
      settle((n) => n + 1);
    });
  });
  // In the sidebar's own order, so a switch never moves a mounted canvas in the DOM.
  const mounted = (sidebarOnly ? [] : workspaces).filter((w) => w.root && (recent.current.includes(w.id) || leaving.current.includes(w.id)));

  const Sidebar = (
    // `min()` guards the mobile overlay, where the chosen width could be wider
    // than the screen it slides over.
    <div
      className={`panel ${sidebarOnly ? '' : 'panel-ring '}flex ${horizontal ? 'h-auto w-full flex-row items-stretch' : 'h-full flex-col'}`}
      style={horizontal ? undefined : { width: `min(${sidebarW}px, 82vw)` }}
      data-agent-panel={sidebarOnly || undefined}
      data-orientation={sidebarOnly ? orientation : undefined}
    >
      <div className={horizontal ? 'flex shrink-0 flex-col items-center justify-center gap-1 border-r border-line px-1.5 py-2' : 'flex items-center justify-between px-3 py-2.5'} data-agent-panel-header>
        {!sidebarOnly && <span className="text-sm font-semibold">Agents</span>}
        {/* A column panel keeps show/hide and orientation at its left and the
            + at its right; a row panel stacks all three in its left strip. */}
        {sidebarOnly && !horizontal && <AgentPanelControls show orientation={orientation} onToggle={() => onClosePanel?.()} onOrientation={(next) => onOrientation?.(next)} />}
        <div className={`relative flex shrink-0 items-center ${horizontal ? 'flex-col gap-1' : 'gap-0.5'}`} ref={newMenuRef}>
          {sidebarOnly ? (
            horizontal && <AgentPanelControls show orientation={orientation} onToggle={() => onClosePanel?.()} onOrientation={(next) => onOrientation?.(next)} />
          ) : (
          <button
            className={`rounded-sm p-1.5 ${contextPanelOpen ? 'bg-surface-2 text-accent' : 'text-ink-faint hover:text-ink'}`}
            title={`${contextPanelOpen ? 'Hide' : 'Show'} the folders, files & context panel (${SHORTCUTS.contextPanel.label})`}
            aria-label={`${contextPanelOpen ? 'Hide' : 'Show'} the folders, files and context panel`}
            aria-pressed={contextPanelOpen}
            onClick={() => useStore.getState().toggleContextPanel()}
          >
            <PanelIcon className="h-3.5 w-3.5" />
          </button>)}
          <button
            ref={newMenuButtonRef}
            className={`agent-panel-plus btn btn-ghost px-1.5 py-1 ${newMenuOpen ? 'is-open' : ''}`}
            title="New agent with a terminal"
            aria-label="New agent"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            onMouseEnter={openNewMenu}
            onMouseLeave={closeNewMenuSoon}
            onFocus={openNewMenu}
            onClick={() => { closeNewMenu(); void newTerminalWorkspace().catch(e => useStore.getState().pushToast('error', e.message)); }}
          >
            <PlusIcon className="h-[22px] w-[22px]" />
          </button>
          {newMenuOpen && newMenuPos && createPortal(
            <div
              ref={newMenuPopRef}
              data-new-agent-menu
              className="card fixed z-[1000] w-64 p-1.5 shadow-lg"
              style={{ background: 'var(--paper)', top: newMenuPos.top, left: newMenuPos.left }}
              onMouseEnter={openNewMenu}
              onMouseLeave={closeNewMenuSoon}
            >
              {/* The hero row. Everything else in this menu opens a window; this
                  one starts the work, so it gets the brand gradient and the rest
                  get a hue apiece rather than four identical grey lines. */}
              <button
                className="create-row create-row-hero flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left"
                onClick={() => { closeNewMenu(); void Promise.resolve(newChat()).catch((e: Error) => useStore.getState().pushToast('error', `Could not start an agent: ${e.message}`)); }}
              >
                <span className="create-tile create-tile-brand">
                  <NekkoAvatar size={16} stationary eyes={false} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">Agent</span>
                  <span className="block text-[11px] text-ink-faint">A fresh chat, with room for windows around it</span>
                </span>
                <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd>
              </button>

              <CreateRow
                tone="var(--accent)"
                icon={<PhotoIcon className="h-4 w-4" />}
                label="Create or Edit Photos and Videos"
                onClick={() => { closeNewMenu(); void newImageChat().catch((e: Error) => useStore.getState().pushToast('error', e.message)); }}
              />
              <CreateRow
                tone="var(--success)"
                icon={<TerminalIcon className="h-4 w-4" />}
                label="Terminal"
                onClick={() => { closeNewMenu(); void newTerminalWorkspace().catch((e: Error) => useStore.getState().pushToast('error', e.message)); }}
              />
            </div>,
            document.body,
          )}
        </div>
      </div>
      <div className={horizontal ? 'agent-panel-row flex min-w-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden px-2 py-1.5' : 'agent-panel-list min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-2 pb-3'} data-agent-panel-list onWheel={horizontal ? scrollRowWithWheel : undefined}>
        {buckets.map((b) => {
          const items = bucketEntries(b.key);
          const done = completedInGroup(sessions, b.key, chatGroupOf);
          if (b.key === '__none' && items.length === 0 && done.length === 0) return null;
          const isCollapsed = collapsed.has(b.key);
          const completedOpen = showCompleted.has(b.key);
          const bucketActive = dropTarget === 'bucket:' + b.key;
          const groupGap = bucketActive && drag?.kind === 'project' && drag.id !== b.key;
          return (
            <div
              key={b.key}
              className={`agent-panel-group mb-1 rounded-lg ${bucketActive && drag?.kind === 'workspace' ? 'bg-accent-soft ring-1 ring-accent/40' : ''}`}
              data-agent-group={b.key}
              data-group-gap={groupGap || undefined}
              onDragOver={(e) => overTarget(e, 'bucket:' + b.key, () => true)}
              onDragLeave={(e) => { if (leftGroup(e.currentTarget, e.relatedTarget) && dropTarget === 'bucket:' + b.key) setDropTarget(null); }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnBucket(b); }}
            >
              <div
                className="group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-surface-2"
                draggable={!!b.ws}
                onDragStart={b.ws ? (e) => {
                  if (pressingGroupAction.current) { e.preventDefault(); return; }
                  startDrag(e, { kind: 'project', id: b.ws!.id, ws: b.ws!.id });
                } : undefined}
                onDragEnd={endDrag}
                title={b.ws ? 'Drag to reorder project' : undefined}
              >
                <button className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left" aria-expanded={!isCollapsed} data-sidebar-group onClick={() => toggleCollapse(b.key)}>
                  <svg
                    className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  ><path d="M9 6l6 6-6 6" /></svg>
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{b.name}</span>
                  {isCollapsed && items.length > 0 && (
                    <span className="ml-1 shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] tabular-nums text-ink-faint">
                      {items.length}
                    </span>
                  )}
                </button>
                {/* Not part of the row's project drag: a press that wanders a few
                    pixels would otherwise start dragging the project, and the
                    click on + never lands. */}
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" data-group-actions
                  onPointerDown={() => { pressingGroupAction.current = true; }}>
                  <button className="rounded-md p-1 text-ink-faint hover:bg-paper hover:text-ink" title="New agent in this project"
                    disabled={pendingProjects.includes(b.key)} aria-label={`New agent in ${b.name}`}
                    onClick={() => { void createInProject('chat', b.ws?.id, b.name); }}><PlusIcon className="h-3.5 w-3.5" /></button>
                  <button className="rounded-md p-1 text-ink-faint hover:bg-paper hover:text-ink" title="New terminal in project"
                    disabled={pendingProjects.includes(b.key)} aria-label={`New terminal in ${b.name}`}
                    onClick={() => { void createInProject('terminal', b.ws?.id, b.name); }}><TerminalIcon className="h-3.5 w-3.5" /></button>
                </span>
              </div>
              {/* Collapsed means gone: hidden, out of the tab order, and taking
                  no room in the row layout either, not just squashed to 0fr. */}
              <div className={`collapse-wrap ${isCollapsed ? 'collapsed' : ''}`} data-group-cards data-collapsed={isCollapsed || undefined} inert={isCollapsed || undefined} aria-hidden={isCollapsed || undefined}>
                <div className="min-h-0 space-y-0.5 overflow-hidden pb-1">
                  {items.length === 0 && (
                    <p className="px-3.5 py-1 text-[11px] text-ink-faint">No active agents</p>
                  )}
                  {items.map((entry) => {
                    const { w, s } = entry;
                    const kids = s ? childrenOf.get(s.id) ?? [] : [];
                    return (
                      <div
                        key={entry.key}
                        {...(s ? { [COMPLETION_ROW_ATTR]: s.id } : {})}
                        onContextMenu={s ? (e) => contextRow(e, s.id) : undefined}
                        onClickCapture={s ? (e) => { if (selectRow(e, s.id)) e.stopPropagation(); } : undefined}
                        style={s && selected.includes(s.id) ? {background:'var(--accent-soft)', borderRadius:8, boxShadow:'inset 0 0 0 1px var(--accent)'} : undefined}
                        draggable
                        onDragStart={(e) => startDrag(e, { kind: 'workspace', id: entry.key, ws: b.ws?.id })}
                        onDragEnd={endDrag}
                        onDragOver={(e) => overTarget(e, 'card:' + entry.key, (d) => d.kind === 'workspace')}
                        onDrop={(e) => {
                           // Project drops belong to the containing group, even over a card.
                           if (drag?.kind !== 'workspace') return;
                           e.preventDefault(); e.stopPropagation(); dropBeforeCard(b, entry.key);
                         }}
                        className={dropTarget === 'card:' + entry.key ? 'rounded-lg ring-1 ring-accent/60' : ''}
                      >
                        <WorkspaceCard
                          workspace={w}
                          session={s}
                          terminal={entry.t}
                          status={s ? statuses.get(s.id) : undefined}
                          isActive={sidebarOnly ? (s?.id ?? entry.t?.id) === selectedId : !!w && w.id === active?.id}
                          now={now}
                          projects={settings?.workspaces ?? []}
                          subAgentCount={kids.length}
                          onOpen={() => {
                            if (sidebarOnly) {
                              if (s) onOpenChat?.(s.id);
                              else if (entry.t) onOpenTerminal?.(entry.t.id);
                              setMobileNav(false);
                            } else if (w) setActiveWorkspace(w.id);
                            else if (s) openChatPane(s.id);
                          }}
                          onClose={() => (w ? archiveWorkspace(w.id) : s ? archiveChat(s.id) : undefined)}
                        />
                        {/* Sub-agents this chat spawned, one line each. */}
                        {kids.map((kid) => (
                          <SubAgentRow
                            key={kid.id}
                            session={kid}
                            status={statuses.get(kid.id)}
                            isActive={kid.id === (sidebarOnly ? selectedId : activeSessionId)}
                            onOpen={() => sidebarOnly ? onOpenChat?.(kid.id) : openChatPane(kid.id)}
                          />
                        ))}
                      </div>
                    );
                  })}
                  {/* Completed chats stay with their group, folded away under
                      the active ones until asked for. */}
                  {done.length > 0 && (
                    <div className="pt-1">
                      <button
                        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-ink-faint hover:bg-surface-2 hover:text-ink"
                        style={sidebarOnly && showTips && done.some((s) => s.id === completionTipSessionId) ? { outline: '2px solid var(--accent)', background: 'var(--surface-2)' } : undefined}
                        aria-expanded={completedOpen}
                        ref={sidebarOnly && showTips && done.some((s) => s.id === completionTipSessionId) ? completionDestinationRef : undefined}
                        data-completed-toggle
                        onClick={() => { useStore.setState({ completionTipSessionId: null }); setShowCompleted((c) => { const n = new Set(c); n.has(b.key) ? n.delete(b.key) : n.add(b.key); return n; }); }}
                      >
                        <svg
                          className={`h-2.5 w-2.5 shrink-0 transition-transform duration-200 ${completedOpen ? 'rotate-90' : ''}`}
                          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                        ><path d="M9 6l6 6-6 6" /></svg>
                        {completedOpen ? 'Hide completed' : `Show completed (${done.length})`}
                      </button>
                      {sidebarOnly && showTips && done.some((s) => s.id === completionTipSessionId) && <div role="status" className="mt-1 rounded-md border border-line p-2 text-[11px] text-ink-soft">
                        Your completed chat is here. Open Show completed to find or restore it.
                        <button className="ml-2 text-accent" onClick={() => useStore.setState({ completionTipSessionId: null })}>Dismiss</button>
                      </div>}
                      {completedOpen && done.map((s) => (
                        <CompletedRow
                          key={s.id}
                          session={s}
                          now={now}
                          isActive={sidebarOnly ? selectedId === s.id : archiveOpen && archivedViewId === s.id}
                          onOpen={() => { if (sidebarOnly) onOpenChat?.(s.id); else openChatPane(s.id); setMobileNav(false); }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    // One field, with every surface on it a panel of the same shape: the
    // sidebar, the windows, the inspector. They used to be three different
    // things — two full-bleed columns on paper with a tray of rounded windows
    // between them — which is why the middle read as the only real panel.
    // As the Agents tab's panel it is one panel among the wall's, not a field of
    // its own: no tinted frame around it, which read as a stray border.
    <div
      // The Agents tab panel takes the column's height and no more, so its card
      // list overflows into its own scroller and the mouse wheel scrolls it.
      className={`flex min-w-0 ${sidebarOnly ? `shrink-0 ${horizontal ? 'w-full' : 'agent-panel-host min-h-0 self-stretch'}` : 'h-full overflow-hidden'}`}
      style={sidebarOnly ? { gap: 'var(--pane-gap)', minHeight: 0 } : { background: 'var(--surface-2)', padding: 'var(--pane-gap)', gap: 'var(--pane-gap)' }}
    >
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <div className="select-text break-all px-2.5 py-2 font-mono text-[10px] text-ink-faint">{menu.ids.length === 1 ? menu.ids[0] : menu.ids.length + ' sessions selected'}</div>
        {menu.model ? <div className="h-72"><ModelPicker expanded open providers={useStore.getState().providers} providerId={null} modelId={null} models={[]} onOpenChange={() => {}} onProvider={() => {}} onModel={(pid, mid) => { const ids = menu.ids; setMenu(null); void Promise.allSettled(ids.map(async id => { const s = await window.nekko.setSessionOptions(id,{providerId:pid,modelId:mid,autoModel:mid===AUTO_MODEL_ID}); if (!s) throw new Error('Chat no longer exists'); window.dispatchEvent(new CustomEvent('nekko-session-brain', {detail:{id,session:s}})); })).then(results => { results.forEach((r,i) => { if(r.status==='rejected') useStore.getState().pushToast('error',ids[i]+': '+String(r.reason)); }); void refreshSessions(); }); }} /></div> : <>
          <ContextAction onClick={() => { menu.ids.forEach(id => sidebarOnly ? onOpenChat?.(id) : openChatPane(id)); setMenu(null); }}>Open{menu.ids.length > 1 ? ' all' : ''}</ContextAction>
          <ContextAction onClick={() => void runAction('complete',menu.ids)}>Mark as completed</ContextAction>
          <ContextAction onClick={() => setMenu({...menu, model:true})}>Change model</ContextAction>
          <ContextAction disabled={!menu.ids.some(id => statuses.has(id))} onClick={() => void runAction('stop',menu.ids)}>Stop{menu.ids.length > 1 ? ' all' : ''}</ContextAction>
          <ContextAction disabled={menu.ids.every(id => statuses.has(id))} onClick={() => void runAction('continue',menu.ids)}>Continue{menu.ids.length > 1 ? ' all' : ''}</ContextAction>
          <ContextAction onClick={() => void runAction('delete',menu.ids)}>Delete permanently</ContextAction>
        </>}
      </ContextMenu>}
      {sidebarOnly && mobileNav && <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setMobileNav(false)} />}
      {/* A row of cards needs no drawer on a narrow screen: it is already out of the way. */}
      {horizontal && <aside className="flex w-full min-w-0">{Sidebar}</aside>}
      {sidebarOnly && !horizontal && <><div className="md:hidden">
        <button className="btn btn-ghost" aria-label="Open agent list" aria-expanded={mobileNav}
          style={!mobileNav && showTips && sessions.some((s) => s.id === completionTipSessionId && s.archivedAt) ? { outline: '2px solid var(--accent)', background: 'var(--surface-2)' } : undefined}
          onClick={() => setMobileNav(true)}>Agents</button>
        {!mobileNav && showTips && sessions.some((s) => s.id === completionTipSessionId && s.archivedAt) && <div role="status" className="mt-1 max-w-40 rounded-md border border-line p-2 text-[11px] text-ink-soft">
          Your completed chat is in the agent list. Open Agents, then Show completed to find or restore it.
          <button className="ml-2 text-accent" onClick={() => useStore.setState({ completionTipSessionId: null })}>Dismiss</button>
        </div>}
      </div><aside className={`${mobileNav ? 'absolute inset-y-0 left-0 z-30 flex p-[var(--pane-gap)]' : 'hidden'} md:relative md:z-auto md:flex md:p-0`}>{Sidebar}</aside>
      {/* The handle sits inside the gap itself (negative margins) so the list
          and the windows keep their one-gap rhythm, grabbed like the window
          dividers: pointer capture, arrow keys, double-click resets. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the agent list"
        aria-valuemin={SIDEBAR_MIN_W}
        aria-valuemax={SIDEBAR_MAX_W}
        aria-valuenow={sidebarW}
        tabIndex={0}
        className="group relative hidden shrink-0 cursor-col-resize md:block"
        style={{ width: 'var(--pane-gap)', marginInline: 'calc(-1 * var(--pane-gap))' }}
        onPointerDown={(e) => {
          e.preventDefault();
          const handle = e.currentTarget;
          const startX = e.clientX;
          const startW = sidebarW;
          handle.setPointerCapture(e.pointerId);
          const onMove = (ev: PointerEvent) => setSidebarW(clampSidebarWidth(startW + ev.clientX - startX));
          const onUp = (ev: PointerEvent) => {
            handle.releasePointerCapture(e.pointerId);
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            saveSidebarW(startW + ev.clientX - startX);
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            saveSidebarW(sidebarW + (e.key === 'ArrowRight' ? 16 : -16));
          } else if (e.key === 'Home') {
            e.preventDefault();
            saveSidebarW(SIDEBAR_MIN_W);
          } else if (e.key === 'End') {
            e.preventDefault();
            saveSidebarW(SIDEBAR_MAX_W);
          }
        }}
        onDoubleClick={() => saveSidebarW(SIDEBAR_DEFAULT_W)}
        title="Drag to resize the agent list · double-click resets"
      >
        <span className="absolute inset-y-0 -left-1 -right-1" />
        <span
          aria-hidden
          className="pane-grip absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </div></>}

      {!sidebarOnly && <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-2 py-1.5 md:hidden">
          <button className="btn btn-ghost px-2 py-1" onClick={() => useStore.getState().setView('command')} aria-label="Open Agents">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <span className="text-[13px] font-semibold">Agents</span>
        </div>

        {/* A completed chat being read takes the middle, over the workspaces,
            which stay mounted underneath so leaving it is instant. */}
        {reading && (
          <div className="panel panel-ring flex min-h-0 flex-1 flex-col overflow-hidden">
            <ChatPane key={`archived:${archivedViewId}`} sessionId={archivedViewId} readOnly />
          </div>
        )}
        {!reading && !active?.root && <EmptyState onNewChat={() => { void newChat(); }} onNewTerminal={() => newTerminal()} />}
        {mounted.length > 0 && (
          // The mounted workspaces share one box, stacked; the one on screen is
          // on top. See WorkspaceCanvas for how the others are kept.
          <div className="relative min-h-0 flex-1" style={active?.root && !reading ? undefined : { display: 'none' }}>
            {mounted.map((w) => (
              <WorkspaceCanvas
                key={w.id}
                workspace={w}
                hidden={w.id !== active?.id}
                sessions={sessions}
                terminals={terminals}
                statuses={statuses}
                projects={settings?.workspaces ?? []}
              />
            ))}
          </div>
        )}
      </main>}

      {/* The right panel: folders + file explorer over the context breakdown. It
          belongs to the app rather than to one window, so opening a file from
          the explorer doesn't take the explorer away with it. It follows the
          active chat, and says so when there isn't one. */}
      {!sidebarOnly && contextPanelOpen && (
        <aside className="panel panel-ring hidden shrink-0 lg:block">
          <ContextInspector sessionId={activeSessionId} />
        </aside>
      )}
    </div>
  );
}

/**
 * A completed chat in its group's "Show completed" list: struck through and
 * muted, led by a check so it can never be mistaken for active work, and dated
 * by when it was completed. Opening it reads it in the middle, read-only.
 */
function CompletedRow({
  session: s, now, isActive, onOpen,
}: {
  session: SessionSummary; now: number; isActive: boolean; onOpen: () => void;
}) {
  const at = s.archivedAt as number;
  const days = archiveDaysLeft(at, now);
  return (
    <button
      onClick={onOpen}
      data-completed-row={s.id}
      className={`flex w-full items-center gap-1.5 rounded-lg py-1 pl-2 pr-2 text-left transition-colors duration-150 ${isActive ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
      title={`${s.title}\nCompleted ${new Date(at).toLocaleString()}\nDeleted on ${new Date(archiveDeletesAt(at)).toLocaleDateString()} unless restored (${days} day${days === 1 ? '' : 's'} left)`}
    >
      <span className="inline-grid shrink-0 place-items-center" style={{ color: 'var(--success)' }} aria-label="Completed" role="img">
        <CheckIcon className="h-3 w-3" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12px] line-through ${isActive ? 'text-ink-soft' : 'text-ink-faint'}`}>{s.title}</span>
      <time
        className="shrink-0 text-[10px] tabular-nums"
        style={{ color: days <= 7 ? 'var(--warning)' : 'var(--ink-faint)' }}
        dateTime={new Date(at).toISOString()}
      >
        {completedDate(at, now)}
      </time>
    </button>
  );
}

/** One sub-agent under its parent's card: a single line, no details of its own. */
function SubAgentRow({
  session, status, isActive, onOpen,
}: {
  session: SessionSummary; status: AgentStatus | undefined; isActive: boolean; onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-center gap-2 rounded-lg py-1 pl-6 pr-2 text-left text-[12px] transition-colors duration-150 ${
        isActive ? 'bg-accent-soft text-ink' : 'text-ink-soft hover:bg-surface-2'
      }`}
    >
      <span
        aria-hidden
        className={`h-[5px] w-[5px] shrink-0 rounded-full bg-transparent ring-1 ${isActive ? 'ring-accent' : 'ring-ink-faint'}`}
      />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {status && <StatusIcon status={status} />}
    </button>
  );
}

/**
 * The workspace on screen: its split tree, rendered, plus the one bit of state
 * the tree itself can't hold — which window is mid-drag, which every other
 * window needs to know so it can offer itself as a target.
 */
const WorkspaceCanvas = React.memo(function WorkspaceCanvas({
  workspace, hidden, sessions, terminals, statuses, projects,
}: {
  workspace: Workspace;
  /** Kept mounted but not on screen. */
  hidden: boolean;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  statuses: Map<string, AgentStatus>;
  projects: WorkspaceFolder[];
}) {
  // The whole tab may be hidden behind the Command Center; a workspace is on screen only when the tab is.
  const tabVisible = usePaneVisible();
  const [dragging, setDragging] = useState<string | null>(null);
  const {
    splitPane, movePane, swapPanes, closePane, setActivePane, canSplitPane, resizePanes,
    newChatInPane, newTerminalInPane,
  } = useStore(
    useShallow((s) => ({
      splitPane: s.splitPane,
      movePane: s.movePane,
      swapPanes: s.swapPanes,
      closePane: s.closePane,
      setActivePane: s.setActivePane,
      canSplitPane: s.canSplitPane,
      resizePanes: s.resizePanes,
      newChatInPane: s.newChatInPane,
      newTerminalInPane: s.newTerminalInPane,
    })),
  );

  // A dropped drag that never fired dragend (cancelled over a non-target) would
  // otherwise leave every window showing a target forever.
  useEffect(() => {
    if (!dragging) return;
    const clear = () => setDragging(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [dragging]);

  /**
   * A new window needs something to point at. Chats and terminals are host
   * objects, so those go through the store and come back with an id; an
   * explorer opens on the workspace's own project when it has one, and a
   * browser on a blank page.
   */
  const addWindow = (paneId: string, dir: Direction, kind: WbPane['kind']) => {
    if (kind === 'chat') return void newChatInPane(paneId, dir);
    if (kind === 'terminal') return void newTerminalInPane(paneId, dir);
    const root =
      kind === 'browser'
        ? 'about:blank'
        : projects.find((p) => p.id === projectOfWorkspace(workspace, sessions, terminals))?.path ??
          projects[0]?.path ??
          '';
    splitPane(paneId, dir, kind, root);
  };

  const chatProject = (pane: WbPane): string | null => {
    if (pane.kind !== 'chat') return null;
    const wid = sessions.find((s) => s.id === pane.refId)?.workspaceId;
    return wid ? projects.find((w) => w.id === wid)?.name ?? null : null;
  };

  const renderNode = (node: WbNode): React.JSX.Element => {
    if (!isSplit(node)) {
      const status = node.kind === 'chat' ? statuses.get(node.refId) : undefined;
      const project = chatProject(node);
      return (
        <PaneFrame
          key={node.id}
          pane={node}
          title={paneTitle(node, sessions, terminals)}
          icon={<PaneIcon kind={node.kind} />}
          badge={
            <>
              {project && (
                <span
                  className="max-w-[90px] shrink-0 truncate rounded-sm px-1 py-px text-[10px] leading-normal text-ink-faint"
                  style={{ background: 'var(--surface-2)' }}
                  title={`Project: ${project}`}
                >
                  {project}
                </span>
              )}
              {node.kind === 'chat' && <StatusIcon status={status} />}
            </>
          }
          isActive={node.id === workspace.activePaneId}
          dragging={dragging}
          canSplit={(dir) => canSplitPane(node.id, dir)}
          onSplit={(dir, kind) => { void addWindow(node.id, dir, kind); }}
          onClose={() => closePane(node.id)}
          onMinimize={() => closePane(node.id)}
          onFocus={() => setActivePane(node.id)}
          onDragStart={() => setDragging(node.id)}
          onDragEnd={() => setDragging(null)}
          onDrop={(target) => {
            if (dragging) {
              if (target === 'swap') swapPanes(dragging, node.id);
              else movePane(dragging, node.id, target);
            }
            setDragging(null);
          }}
        >
          <PaneBody pane={node} hidden={hidden} />
        </PaneFrame>
      );
    }
    return (
      // No `gap` here: the Divider between two windows is itself --pane-gap
      // wide, so it is the space they keep. Each child's share is a flex-grow
      // weight rather than a percentage of the box, since bases that summed to
      // 100% pushed the last window's width past the edge once the dividers
      // took theirs, which is how a row's rightmost window could slide under
      // the inspector.
      <div
        key={node.id}
        className={`flex min-h-0 min-w-0 flex-1 ${node.dir === 'row' ? 'flex-row' : 'flex-col'}`}
      >
        {node.children.map((child, i) => (
          <React.Fragment key={child.id}>
            {i > 0 && <Divider splitId={node.id} index={i - 1} dir={node.dir} onResize={resizePanes} />}
            <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i]} 1 0` }}>
              {renderNode(child)}
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  };

  return (
    // The field and its padding belong to the workbench now, so the windows sit
    // on the same surface, at the same gap, as the sidebar and the inspector.
    // A hidden workspace is skipped with content-visibility rather than
    // display:none: its styles, layout and scroll positions are kept, so
    // showing it again is a paint, not a rebuild. It sits under the one on
    // screen, which covers it, so it never takes a click.
    <div
      className="absolute inset-0 flex min-h-0"
      style={{ gap: 'var(--pane-gap)', zIndex: hidden ? 0 : 1, contentVisibility: hidden ? 'hidden' : 'visible' }}
      aria-hidden={hidden || undefined}
    >
      <PaneVisibleContext.Provider value={!hidden && tabVisible}>{renderNode(workspace.root!)}</PaneVisibleContext.Provider>
    </div>
  );
});

function EmptyState({ onNewChat, onNewTerminal }: { onNewChat: () => void; onNewTerminal: () => void }) {
  return (
    // A panel of its own, so an empty workbench is still a surface rather than a
    // hole in the field the windows would otherwise sit on.
    <div className="panel panel-ring flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={34} /></div>
      <div>
        <h2 className="text-lg font-semibold">No agent open</h2>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-faint">
          An agent is a chat and whatever it needs around it, files, a terminal, a browser, all on screen at once.
          Start one and add windows on any side.
        </p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={onNewChat}>
          <ChatIcon className="h-4 w-4" /> New agent <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd>
        </button>
        <button className="btn btn-outline" onClick={onNewTerminal}>
          <TerminalIcon className="h-4 w-4" /> New terminal <kbd className="kbd">{SHORTCUTS.newTerminal.label}</kbd>
        </button>
      </div>
    </div>
  );
}
