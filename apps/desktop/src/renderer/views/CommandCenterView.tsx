import { AgentWindowPicker, type AgentWindowSelection } from '../components/AgentWindowPicker.js';
import { NumberedChatIcon } from '../components/NumberedChatIcon.js';
import { createPortal } from 'react-dom';
import { hasAppChrome } from '../chrome.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AutomationTask, PendingInput, SessionSummary, UsageSummary } from '@agent-nekko/shared';
import type { AgentType } from '@agent-nekko/shared';
import { AUTO_MODEL_ID, classifyAgent, classifySession, formatUSD, summarizeSession } from '@agent-nekko/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { runningSessionIds } from '../liveRuns.js';
import { GridIcon, PlusIcon, TerminalIcon, FocusLayoutIcon, FixedLayoutIcon, PanelIcon, WandIcon } from '../icons.js';
import { CommandWall, TerminalExcerpt } from '../components/CommandWall.js';
import { WallComposer, type WallAgent } from '../components/WallComposer.js';
import { BLOCKED_META, LANE_META, sessionLane } from '@agent-nekko/shared';
import { type Vitals } from '../components/InsightsBox.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { WallDock } from '../components/WallDock.js';

import { allPanes, isSplit, type PaneKind } from '../layout.js';
import {
  DEFAULT_ASPECT,
  addPane,
  hasPane,
  loadWallState,
  nextAgent,
  reconcileWall,
  wallAgents,
  saveWallState,
  tileTree,
  toWallSetting,
  wallPane,
  type CommandWallState,
  type WallFilter,
} from '../commandWall.js';

const HOUR = 60 * 60_000;

/**
 * The Command Center: every agent and terminal as a live window on one wall,
 * arranged in the same split tree the Agent tab uses, with the automations
 * list and the insights box as windows among them. The windows are the same
 * chat and terminal panes the Agent tab shows, so work gets handled here, not
 * just watched; waiting windows draw attention with their own glowing ring.
 */
export function CommandCenterView() {
  const { sessions, terminals, providers, settings, activeProjectId, setView, openChatPane, openTerminalPane, refreshSessions, refreshTerminals } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      terminals: s.terminals,
      providers: s.providers,
      settings: s.settings,
      activeProjectId: s.activeProjectId,
      setView: s.setView,
      openChatPane: s.openChatPane,
      openTerminalPane: s.openTerminalPane,
      refreshSessions: s.refreshSessions,
      refreshTerminals: s.refreshTerminals,
    })),
  );
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => {
    const refresh = () => { void window.nekko.getUsageSummary().then(setUsage).catch(() => {}); };
    window.addEventListener('nekko:usage-refresh', refresh);
    return () => window.removeEventListener('nekko:usage-refresh', refresh);
  }, []);
  // Which chats are mid-turn. Seeded from the app-wide fold of agent events,
  // so a chat that was already working shows as working on the first frame
  // rather than idle until its next token; the host confirms the set on
  // mount, for runs that began before this window did.
  const [running, setRunning] = useState<Set<string>>(() => new Set(runningSessionIds()));
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  // What each chat is waiting on a person for, read from the host so a question
  // asked while this screen was closed shows on its window when it opens.
  const [pending, setPending] = useState<Record<string, PendingInput>>({});
  const [, setTick] = useState(0);
  const now = Date.now();

  // The wall itself: a setting, so the desktop, web and phone editions of one
  // install show the same wall, with the browser's copy as the fast first
  // paint. Kept honest against the chats and terminals that exist, and grown
  // by every new chat while auto-add is on.
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
  const [wall, setWallState] = useState<CommandWallState>(() => loadWallState(storage, useStore.getState().settings?.commandWall));
  const setWall = useCallback((update: (s: CommandWallState) => CommandWallState) => setWallState((s) => update(s)), []);
  const firstSave = useRef(true);
  useEffect(() => {
    saveWallState(storage, wall);
    // The first run is the load itself; after that, every change goes to the
    // host a moment after it settles (a divider drag is many changes a second).
    if (firstSave.current) { firstSave.current = false; return; }
    const t = setTimeout(() => {
      const setting = toWallSetting(wall);
      useStore.setState((s) => (s.settings ? { settings: { ...s.settings, commandWall: setting } } : {}));
      window.nekko.updateSettings({ commandWall: setting }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall]);
  // The stage's shape, as the wall measures it, for placing windows nobody
  // pointed at a side for: beside the biggest window, along its longer side.
  const aspectRef = useRef(DEFAULT_ASPECT);
  const onAspect = useCallback((a: number) => { aspectRef.current = a; }, []);
  // Not before both lists have loaded once: reconciling against the empty
  // lists the view mounts with would seed an empty wall and watermark every
  // chat that already exists out of it.
  const [listsReady, setListsReady] = useState(false);
  useEffect(() => {
    if (listsReady) setWallState((w) => reconcileWall(w, sessions, terminals, Date.now(), aspectRef.current));
  }, [listsReady, sessions, terminals]);

  useEffect(() => {
    window.nekko.getUsageSummary().then(setUsage);
    Promise.all([refreshSessions(), refreshTerminals()]).finally(() => setListsReady(true));
    window.nekko.listTasks().then(setTasks).catch(() => setTasks([]));
    window.nekko.pendingInput().then(setPending).catch(() => {});
    window.nekko.runningSessions().then((ids) => setRunning((r) => (ids.every((id) => r.has(id)) ? r : new Set([...r, ...ids])))).catch(() => {});
    const off = window.nekko.onTasksUpdated(setTasks);
    return off;
  }, [refreshSessions, refreshTerminals]);

  const refreshPending = () => { window.nekko.pendingInput().then(setPending).catch(() => {}); };

  const taskBySession = useMemo(() => {
    const m = new Map<string, AutomationTask>();
    for (const t of tasks) if (t.lastSessionId) m.set(t.lastSessionId, t);
    return m;
  }, [tasks]);

  // Track running sessions live; a freshly spawned sub-agent re-lists sessions,
  // which is how it reaches the wall.
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'question' || e.type === 'tool_approval_required' || e.type === 'question_resolved' || e.type === 'tool_result') refreshPending();
      if (e.type === 'done' || e.type === 'error') {
        setRunning((r) => { const n = new Set(r); n.delete(e.sessionId); return n; });
        window.nekko.getUsageSummary().then(setUsage);
        refreshPending();
        refreshSessions();
      } else {
        setRunning((r) => (r.has(e.sessionId) ? r : new Set(r).add(e.sessionId)));
      }
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // The automation countdowns tick every 30s.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const childrenOf = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of sessions) if (s.parentSessionId) m.set(s.parentSessionId, [...(m.get(s.parentSessionId) ?? []), s]);
    return m;
  }, [sessions]);
  const topLevel = useMemo(() => sessions.filter((s) => !s.parentSessionId && !s.taskId && !s.trainingRunId && !s.archivedAt), [sessions]);
  const isRunningSession = useMemo(
    () => (s: SessionSummary) => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => running.has(k.id)),
    [running, childrenOf],
  );

  const vitals = useMemo<Vitals>(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayTokens = usage?.daily.find((d) => d.date === todayKey);
    const isSubscriptionSpend = !!usage?.hasSubscriptionUsage && (usage?.totalCost ?? 0) === 0;
    type Member = { type: AgentType; running: boolean };
    const members: Member[] = [];
    for (const s of topLevel) {
      if (!isRunningSession(s) && now - s.updatedAt >= 24 * HOUR) continue;
      members.push({ type: classifySession(s, taskBySession.get(s.id)), running: isRunningSession(s) });
    }
    for (const t of tasks) {
      if (t.status !== 'active') continue;
      members.push({ type: classifyAgent({ taskKind: t.kind, taskCondition: t.condition, prompt: t.prompt }), running: !!t.lastSessionId && running.has(t.lastSessionId) });
    }
    const byRole = new Map<string, { type: AgentType; count: number; live: number }>();
    for (const m of members) {
      const e = byRole.get(m.type.role) ?? { type: m.type, count: 0, live: 0 };
      e.count++;
      if (m.running) e.live++;
      byRole.set(m.type.role, e);
    }
    return {
      working: running.size,
      waiting: topLevel.filter((s) => !!pending[s.id]).length,
      automations: tasks.filter((t) => t.status === 'active').length,
      terminals: terminals.filter((t) => t.running).length,
      tokensToday: todayTokens ? todayTokens.input + todayTokens.output : 0,
      spend: isSubscriptionSpend ? 'Included in plan' : formatUSD(usage?.totalCost ?? 0),
      fleet: [...byRole.values()].sort((a, b) => b.count - a.count),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage, topLevel, tasks, running, pending, terminals, taskBySession, isRunningSession]);

  const openChat = (id: string) => { openChatPane(id); setView('chat'); };
  const openTerminal = (id: string) => { openTerminalPane(id); setView('chat'); };

  // Starting work from the wall keeps you on the wall: the new chat or shell
  // becomes a window here rather than switching to the Agent tab.
  // Retain an unconfigured session when host cleanup fails, so retrying does
  // not create a second orphan. Clear it only after configuration or deletion.
  const unfinishedChat = useRef<Awaited<ReturnType<typeof window.nekko.createSession>> | null>(null);
  const newChat = async (selection?: AgentWindowSelection): Promise<string> => {
    let s = unfinishedChat.current ?? await window.nekko.createSession(activeProjectId ?? undefined);
    if (unfinishedChat.current && !selection) selection = { kind: 'chat', chatType: 'multimodal' };
    if (selection) {
      try {
        const updated = await window.nekko.setSessionOptions(s.id, { chatType: selection.chatType ?? 'multimodal', ...(selection.providerId ? { providerId: selection.providerId } : {}), ...(selection.modelId ? { modelId: selection.modelId, autoModel: selection.modelId === AUTO_MODEL_ID } : {}) });
        if (!updated) throw new Error('Could not configure the new agent window.');
        s = updated;
      } catch (error) {
        unfinishedChat.current = s;
        try {
          await window.nekko.deleteSession(s.id);
          unfinishedChat.current = null;
        } catch (cleanupError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Retry will reuse this session.`);
        }
        throw error;
      }
    }
    unfinishedChat.current = null;
    useStore.setState((state) => ({ sessions: [summarizeSession(s), ...state.sessions.filter((existing) => existing.id !== s.id)] }));
    return s.id;
  };
  const newTerminal = async (): Promise<string> => {
    const t = await window.nekko.createTerminal({ workspaceId: activeProjectId ?? undefined });
    useStore.setState((state) => ({ terminals: [t, ...state.terminals.filter((existing) => existing.id !== t.id)] }));
    return t.id;
  };
  /** A window from the toolbar, with no side pointed at: beside the biggest window. */
  const addFromToolbar = async (kind: PaneKind, refId?: string) => {
    const ref = refId ?? (kind === 'chat' ? await newChat() : kind === 'terminal' ? await newTerminal() : kind);
    setWall((w) => ({ ...w, root: hasPane(w.root, kind, ref) ? w.root : addPane(w.root, wallPane(kind, ref), aspectRef.current), ...(kind === 'chat' ? { hero: ref } : {}) }));
    if (kind === 'chat') setSelected(ref);
  };
  const autoArrange = () => setWall((w) => w.layout.mode === 'grid' ? { ...w, root: tileTree(allPanes(w.root), aspectRef.current) } : w);

  // The agent the composer speaks for: the window clicked last, or the first
  // on the wall. Ctrl+Tab / Ctrl+Shift+Tab walk the windows in reading order;
  // Ctrl+1…9 (or Alt+1…9) pick one by its number.
  const [addOpen, setAddOpen] = useState(false);
  const [tabsMenu, setTabsMenu] = useState<{ x: number; y: number } | null>(null);
  const closeTabsMenu = useCallback(() => setTabsMenu(null), []);
  const openTabsMenu = (e: React.MouseEvent) => { e.preventDefault(); setTabsMenu({ x: e.clientX, y: e.clientY }); };
  const [selected, setSelected] = useState<string | null>(() => wall.hero);
  const selectAgent = useCallback((id: string | null) => {
    setSelected(id);
    setWall((w) => w.hero === id ? w : { ...w, hero: id });
  }, [setWall]);
  const agentsOnWall = useMemo(() => wallAgents(wall.root), [wall.root]);
  useEffect(() => {
    if (agentsOnWall.length === 0) { if (selected) selectAgent(null); return; }
    if (!selected || !agentsOnWall.some((p) => p.refId === selected)) selectAgent(agentsOnWall.find((p) => p.refId === wall.hero)?.refId ?? agentsOnWall[0].refId);
  }, [agentsOnWall, selected, wall.hero, selectAgent]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        selectAgent(nextAgent(wall.root, selected, e.shiftKey ? -1 : 1));
        return;
      }
      if ((e.ctrlKey || e.altKey) && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const agents = wallAgents(wall.root);
        const pick = agents[Number(e.key) - 1];
        if (!pick) return;
        e.preventDefault();
        selectAgent(pick.refId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wall.root, selected, selectAgent]);
  const composerRef = useRef<HTMLDivElement>(null);
  const agentList = useMemo<WallAgent[]>(() => agentsOnWall.flatMap((p, i) => {
    const session = sessions.find((x) => x.id === p.refId);
    if (!session) return [];
    const { lane, blocked } = sessionLane({ running: isRunningSession(session), pending: pending[session.id], stalled: session.stalled });
    const status = lane === 'needs-you' && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone, live: true } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
    return [{ session, n: i + 1, status }];
  }), [agentsOnWall, sessions, pending, isRunningSession]);
  const selectedAgent = agentList.find((a) => a.session.id === selected) ?? null;
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  const composerSplit = <div className="wall-composer-split" role="separator" tabIndex={0} aria-label="Resize composer versus wall" aria-orientation="horizontal" title="Drag to resize composer versus wall; double-click to reset"
    onPointerDown={(e) => { composerDrag.current = { y: e.clientY, height: composerRef.current?.offsetHeight ?? 240 }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { const drag = composerDrag.current; if (!drag) return; const available = e.currentTarget.parentElement?.clientHeight ?? 700; setComposerHeight(Math.max(120, Math.min(available * .7, drag.height + (e.clientY - drag.y) * (wall.composer.side === 'top' ? 1 : -1)))); }}
    onPointerUp={() => { composerDrag.current = null; }} onPointerCancel={() => { composerDrag.current = null; }}
    onDoubleClick={() => setComposerHeight(null)}
    onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); setComposerHeight(null); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const available = e.currentTarget.parentElement?.clientHeight ?? 700; setComposerHeight(Math.max(120, Math.min(available * .7, (composerHeight ?? composerRef.current?.offsetHeight ?? 240) + (e.key === 'ArrowUp' ? 20 : -20) * (wall.composer.side === 'top' ? -1 : 1)))); } }} />;
  const composer = (
    <WallComposer
      height={composerHeight}
      agent={selectedAgent}
      agents={agentList}
      dock={wall.composer}
      onDock={(composer) => setWall((w) => ({ ...w, composer }))}
      onSelect={selectAgent}
      onOpen={openChat}
      onNewAgent={() => { void addFromToolbar('chat'); }}
      panelRef={composerRef}
    />
  );

  const tabsToggle = <button type="button" className="btn btn-ghost wall-tabs-toggle" aria-label={wall.tabs === 'left' ? 'Switch to horizontal agent tabs' : 'Switch to vertical agent tabs'} title={wall.tabs === 'left' ? 'Switch to horizontal agent tabs' : 'Switch to vertical agent tabs'} onContextMenu={openTabsMenu} onClick={() => setWall(w => ({ ...w, tabs: w.tabs === 'left' ? 'top' : 'left' }))}><PanelIcon className={`h-4 w-4 ${wall.tabs === 'left' ? 'rotate-90' : ''}`} /></button>;
  const [wideHeader, setWideHeader] = useState(() => window.innerWidth >= 1100);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1100px)');
    const update = () => setWideHeader(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const titleSlot = hasAppChrome ? document.getElementById('command-titlebar-title') : null;
  const toolbarSlot = hasAppChrome ? document.getElementById('command-titlebar-slot') : null;
  const title = <h1 className="text-gradient text-xl font-semibold">Agents</h1>;
  const toolbar = <WallToolbar wall={wall} setWall={setWall} onAutoArrange={autoArrange} addOpen={addOpen} setAddOpen={setAddOpen} tabsToggle={wall.tabs === 'left' || wall.tabs === 'hidden' ? tabsToggle : null} />;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-1 xl:px-6">
      {titleSlot && toolbarSlot ? <>{createPortal(title, titleSlot)}{wideHeader ? createPortal(toolbar, toolbarSlot) : toolbar}</> : <div className="flex flex-wrap items-center gap-3">{title}{toolbar}</div>}
      {tabsMenu && <ContextMenu x={tabsMenu.x} y={tabsMenu.y} onClose={closeTabsMenu}>{(['top', 'left', 'hidden'] as const).map((tabs) => <ContextAction key={tabs} onClick={() => { setWall(w => ({ ...w, tabs })); closeTabsMenu(); }}>{(wall.tabs ?? 'top') === tabs ? '✓ ' : ''}{tabs === 'top' ? 'Top tabs' : tabs === 'left' ? 'Vertical tabs (left)' : 'Hide tab panel'}</ContextAction>)}</ContextMenu>}
      <div className="wall-workspace" data-dock-side={wall.dock.side}>
        <WallDock state={wall} setState={setWall} tasks={tasks} running={running} now={now} sessions={sessions} providers={providers} usage={usage} vitals={vitals} onOpenChat={openChat} onOpenModels={() => setView('models')} />
        <div className="wall-agent-workspace" data-tabs={wall.tabs ?? 'top'}>
      {wall.tabs !== 'hidden' && <div className="wall-focus-agents" role="toolbar" aria-label="Focus agents" onContextMenu={openTabsMenu}>
        {(wall.tabs ?? 'top') === 'top' && tabsToggle}
        {agentList.map((agent) => <button key={agent.session.id} className="wall-focus-agent" aria-pressed={wall.hero === agent.session.id} onClick={() => selectAgent(agent.session.id)}>
          <NumberedChatIcon number={agent.n} /><span className="min-w-0 text-left"><span className="block truncate">{agent.session.title}</span><small className="block truncate text-ink-faint">{agent.session.modelId || 'Default model'} · {agent.session.transcriptTokens.toLocaleString()} context tokens</small></span>
          {agent.status && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: agent.status.tone }} />}
        </button>)}
        {allPanes(wall.root).filter(p => p.kind === 'terminal').map(p => <button key={p.id} className="wall-focus-agent" aria-pressed={wall.hero === p.refId} aria-label={`Focus terminal ${p.refId}`} onClick={() => setWall(w => ({ ...w, hero: p.refId }))}><TerminalIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 text-left"><span className="block truncate">{terminals.find(t => t.id === p.refId)?.title || 'Terminal'}</span><TerminalExcerpt terminalId={p.refId} /></span></button>)}
        <button className="wall-focus-agent" onClick={() => { void addFromToolbar('chat'); }}>+ New agent</button>
      </div>}
      <div className="wall-column">
      {wall.layout.mode !== 'focus' && wall.composer.side === 'top' && <>{composer}{composerSplit}</>}
      <CommandWall
        state={wall}
        setState={setWall}
        sessions={sessions}
        terminals={terminals}
        running={running}
        pending={pending}
        childrenOf={childrenOf}
        projects={settings?.workspaces ?? []}
        flash={null}
        selectedId={selected}
        onSelect={selectAgent}
        onAspect={onAspect}
        onOpenChat={openChat}
        onOpenTerminal={openTerminal}
        onNewChat={newChat}
        onNewTerminal={newTerminal}
        onAddWindow={() => setAddOpen((open) => !open)}
        addContent={addOpen ? <AgentWindowPicker onClose={() => setAddOpen(false)} onAdd={async (selection) => {
          const ref = selection.refId ?? (selection.kind === 'chat' ? await newChat(selection) : await newTerminal());
          await addFromToolbar(selection.kind, ref);
          if (selection.kind === 'chat') selectAgent(ref);
          setAddOpen(false);
        }} /> : undefined}
      />
      {wall.layout.mode !== 'focus' && wall.composer.side === 'bottom' && <>{composerSplit}{composer}</>}
        </div>
      </div>
      </div>
    </div>
  );
}

/* ---------- toolbar ---------- */

const FILTERS: Array<{ key: WallFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Agents' },
  { key: 'terminal', label: 'Terminals' },
];

function WallToolbar({
  wall,
  setWall,
  onAutoArrange,
  addOpen,
  setAddOpen,
  tabsToggle,
}: {
  tabsToggle: React.ReactNode;
  wall: CommandWallState;
  setWall: (update: (s: CommandWallState) => CommandWallState) => void;
  onAutoArrange: () => void;
  addOpen: boolean;
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [fixedOpen, setFixedOpen] = useState(false);
  const [hoverSize, setHoverSize] = useState({ rows: wall.layout.rows, cols: wall.layout.cols });
  const fixedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fixedOpen) return;
    const down = (e: MouseEvent) => { if (!fixedRef.current?.contains(e.target as Node)) setFixedOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setFixedOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [fixedOpen]);
  const canArrange = wall.layout.mode === 'grid' && !!wall.root && isSplit(wall.root);

  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
      {tabsToggle}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="wall-layout-control" ref={fixedRef}>
          <div className="wall-layout-segments" role="group" aria-label="Wall layout">
            {(['focus', 'grid', 'fixed'] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={wall.layout.mode === mode} aria-expanded={mode === 'fixed' ? fixedOpen : undefined} onClick={() => {
                if (mode === 'fixed') { setHoverSize({ rows: wall.layout.rows, cols: wall.layout.cols }); setFixedOpen((open) => !open); }
                else { setFixedOpen(false); setWall((w) => ({ ...w, layout: { ...w.layout, mode } })); }
              }}>{React.createElement(mode === 'focus' ? FocusLayoutIcon : mode === 'grid' ? GridIcon : FixedLayoutIcon, { className: 'h-4 w-4' })}{mode[0].toUpperCase() + mode.slice(1)}</button>
            ))}
          </div>
          {fixedOpen && <div className="wall-fixed-picker" role="dialog" aria-label="Fixed grid size">
            <p>{hoverSize.cols} columns × {hoverSize.rows} rows</p>
            <div className="wall-fixed-cells" onMouseLeave={() => setHoverSize({ rows: wall.layout.rows, cols: wall.layout.cols })}>
              {Array.from({ length: 36 }, (_, i) => {
                const rows = Math.floor(i / 6) + 1;
                const cols = i % 6 + 1;
                return <button key={i} type="button" aria-label={`${cols} columns by ${rows} rows`} className={rows <= hoverSize.rows && cols <= hoverSize.cols ? 'is-preview' : ''} onMouseEnter={() => setHoverSize({ rows, cols })} onFocus={() => setHoverSize({ rows, cols })} onClick={() => { setWall((w) => ({ ...w, layout: { mode: 'fixed', rows, cols } })); setFixedOpen(false); }} />;
              })}
            </div>
          </div>}
        </div>
        <div className="inline-flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={wall.filter === f.key}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${wall.filter === f.key ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
              onClick={() => setWall((w) => ({ ...w, filter: f.key }))}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-outline gap-1.5 py-1 text-[12px] disabled:opacity-50"
          title="Fit windows above the composer in even rows and columns"
          aria-label="Auto-arrange"
          onClick={onAutoArrange}
          disabled={!canArrange}
        >
          <WandIcon className="h-4 w-4" />
        </button>
        <button type="button" className="btn btn-outline gap-1.5 py-1 text-[12px]" aria-pressed={wall.dock.show} onClick={() => setWall((w) => ({ ...w, dock: { ...w.dock, show: !w.dock.show } }))}><PanelIcon className="h-4 w-4" />Panels</button>
        <div className="relative">
          <button
            className="btn btn-outline gap-1.5 py-1 text-[12px] disabled:opacity-50"
            onClick={() => setAddOpen((o) => !o)}
            aria-controls="wall-window-picker"
            aria-expanded={addOpen}
            title="Add an agent, a terminal, or a chat already running"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add window
          </button>
        </div>
      </div>
    </div>
  );
}
