import { AgentWindowPicker, defaultFolderIds, type AgentWindowSelection } from '../components/AgentWindowPicker.js';
import { AgentSidebar } from './WorkspacesView.js';
import { ChatPane } from '../components/ChatPane.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, AutomationTask, PendingInput, SessionSummary, UsageSummary } from '@nekko-agent/shared';
import type { AgentType } from '@nekko-agent/shared';
import { AUTO_MODEL_ID, classifyAgent, classifySession, formatUSD, summarizeSession } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { runningSessionIds } from '../liveRuns.js';
import { GridIcon, MoreVerticalIcon, TerminalIcon, FocusLayoutIcon, FixedLayoutIcon, PanelIcon, WandIcon } from '../icons.js';
import { COMPANION_OPENED_EVENT } from '../components/AgentCompanionButtons.js';
import { NekkoAvatar } from '../components/Mascot.js';
import { AgentPanelControls } from '../components/AgentPanelControls.js';
import { CommandWall } from '../components/CommandWall.js';
import { WallComposer, type WallAgent } from '../components/WallComposer.js';
import { agentStatusOfLane } from '../components/WorkspaceCard.js';
import { BLOCKED_META, LANE_META, sessionLane } from '@nekko-agent/shared';
import { type Vitals } from '../components/InsightsBox.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { WallDock } from '../components/WallDock.js';
import { hasAppChrome } from '../chrome.js';

import { allPanes, isSplit, type PaneKind } from '../layout.js';
import {
  DEFAULT_ASPECT,
  addPane,
  hasPane,
  loadWallState,
  nextAgent,
  reconcileWall,
  readAgentPanel,
  wallAgents,
  saveWallState,
  tileTree,
  toWallSetting,
  wallPane,
  type CommandWallState,
  type WallFilter,
} from '../commandWall.js';

const HOUR = 60 * 60_000;

/** Physical digits also work when Shift produces !, @, or #. */
export function wallLayoutShortcut(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>) {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.altKey || !e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey)) return null;
  const digit = /^Digit[1-3]$/.test(e.code) ? e.code.slice(-1) : /^[1-3]$/.test(e.key) ? e.key : null;
  return digit === '1' ? 'focus' : digit === '2' ? 'grid' : digit === '3' ? 'fixed' : null;
}

/**
 * What each saved layout mode is called. The free-form tiled wall reads as
 * Dynamic; the even rows and columns read as Grid. Saved values keep their
 * original keys so existing walls load unchanged.
 */
export const LAYOUT_LABEL: Record<'focus' | 'grid' | 'fixed', string> = { focus: 'Focus', grid: 'Dynamic', fixed: 'Grid' };

function layoutShortcutLabel(mode: 'focus' | 'grid' | 'fixed') {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return `${mac ? '⌘' : 'Ctrl'}+Shift+${mode === 'focus' ? 1 : mode === 'grid' ? 2 : 3}`;
}

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
  const viewRef = useRef<HTMLDivElement>(null);
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
  const newChat = async (selection?: AgentWindowSelection, projectId = activeProjectId ?? undefined): Promise<string> => {
    // A chat started with no picker (the toolbar, a window's split) gets the
    // saved default folders, when there are any.
    if (!selection) {
      const saved = useStore.getState().settings;
      const defaults = defaultFolderIds(saved?.defaultWorkspaceIds, saved?.workspaces ?? []);
      if (defaults.length) selection = { kind: 'chat', chatType: 'multimodal', workspaceIds: defaults };
    }
    // Folders picked in Add window override the project default: the first is
    // the chat's working folder, any others are supporting folders.
    const [primaryFolder, ...supportingFolders] = selection?.workspaceIds ?? [];
    let s = unfinishedChat.current ?? await window.nekko.createSession(selection?.workspaceIds ? primaryFolder : projectId);
    if (unfinishedChat.current && !selection) selection = { kind: 'chat', chatType: 'multimodal' };
    if (selection) {
      try {
        if (unfinishedChat.current && selection.workspaceIds) {
          const relocated = await window.nekko.setSessionWorkspace(s.id, primaryFolder);
          if (!relocated) throw new Error('Could not configure the new agent working folder.');
          s = relocated;
        }
        const updated = await window.nekko.setSessionOptions(s.id, { chatType: selection.chatType ?? 'multimodal', ...(selection.providerId ? { providerId: selection.providerId } : {}), ...(selection.modelId ? { modelId: selection.modelId, autoModel: selection.modelId === AUTO_MODEL_ID } : {}) });
        if (!updated) throw new Error('Could not configure the new agent window.');
        s = updated;
        if (selection.workspaceIds) {
          const configured = await window.nekko.setSessionSupportingWorkspaces(s.id, supportingFolders);
          if (!configured) throw new Error('Could not configure the new agent folders.');
          s = configured;
        }
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
  const newTerminal = async (workspaceId = activeProjectId ?? undefined, shell?: string): Promise<string> => {
    const t = await window.nekko.createTerminal({ workspaceId, shell });
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
  const [completedId, setCompletedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => wall.hero);
  const selectAgent = useCallback((id: string | null) => {
    setCompletedId(null);
    setSelected(id);
    setWall((w) => w.hero === id ? w : { ...w, hero: id });
  }, [setWall]);
  const agentsOnWall = useMemo(() => wallAgents(wall.root), [wall.root]);
  const panel = readAgentPanel(wall.agentPanel);
  useEffect(() => {
    if (agentsOnWall.length === 0) { if (selected) selectAgent(null); return; }
    if (!selected || !agentsOnWall.some((p) => p.refId === selected)) selectAgent(agentsOnWall.find((p) => p.refId === wall.hero)?.refId ?? agentsOnWall[0].refId);
  }, [agentsOnWall, selected, wall.hero, selectAgent]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().view !== 'command' || document.visibilityState === 'hidden' || !viewRef.current?.getClientRects().length || e.defaultPrevented || e.repeat || e.isComposing) return;
      const mode = wallLayoutShortcut(e);
      if (mode) {
        e.preventDefault();
        setWall((w) => ({ ...w, layout: { ...w.layout, mode } }));
        return;
      }
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        selectAgent(nextAgent(wall.root, selected, e.shiftKey ? -1 : 1));
        return;
      }
      if ((e.ctrlKey || e.altKey) && !e.shiftKey && !e.metaKey && !(e.ctrlKey && e.altKey) && /^[1-9]$/.test(e.key)) {
        const agents = wallAgents(wall.root);
        const pick = agents[Number(e.key) - 1];
        if (!pick) return;
        e.preventDefault();
        selectAgent(pick.refId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wall.root, selected, selectAgent, setWall]);
  const composerRef = useRef<HTMLDivElement>(null);
  const agentList = useMemo<WallAgent[]>(() => agentsOnWall.flatMap((p, i) => {
    const session = sessions.find((x) => x.id === p.refId);
    if (!session) return [];
    const { lane, blocked } = sessionLane({ running: isRunningSession(session), pending: pending[session.id], stalled: session.stalled });
    const status = lane === 'needs-you' && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone, live: true } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
    return [{ session, n: i + 1, status, glyph: agentStatusOfLane(lane, blocked) }];
  }), [agentsOnWall, sessions, pending, isRunningSession]);
  const selectedAgent = agentList.find((a) => a.session.id === selected) ?? null;
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  const composerSplit = <div className="wall-composer-split" role="separator" tabIndex={0} aria-label="Resize composer versus wall" aria-orientation="horizontal" title="Drag to resize composer versus wall; double-click to reset"
    onPointerDown={(e) => { composerDrag.current = { y: e.clientY, height: composerRef.current?.offsetHeight ?? 240 }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { const drag = composerDrag.current; if (!drag) return; const available = composerRef.current?.closest('.wall-column')?.clientHeight ?? 700; setComposerHeight(Math.max(120, Math.min(available * .7, drag.height + (e.clientY - drag.y) * (wall.composer.side === 'top' ? 1 : -1)))); }}
    onPointerUp={() => { composerDrag.current = null; }} onPointerCancel={() => { composerDrag.current = null; }}
    onDoubleClick={() => setComposerHeight(null)}
    onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); setComposerHeight(null); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const available = composerRef.current?.closest('.wall-column')?.clientHeight ?? 700; setComposerHeight(Math.max(120, Math.min(available * .7, (composerHeight ?? composerRef.current?.offsetHeight ?? 240) + (e.key === 'ArrowUp' ? 20 : -20) * (wall.composer.side === 'top' ? -1 : 1)))); } }} />;
  const composer = (
    <WallComposer
      height={composerHeight}
      resizeHandle={composerSplit}
      agent={selectedAgent}
      agents={agentList}
      dock={wall.composer}
      onDock={(composer) => setWall((w) => ({ ...w, composer }))}
      onSelect={selectAgent}
      onOpen={openChat}
      onFocus={(id) => {
        selectAgent(id);
        setWall((w) => ({ ...w, hero: id, layout: { ...w.layout, mode: 'focus' } }));
      }}
      onNewAgent={() => { void addFromToolbar('chat'); }}
      panelRef={composerRef}
    />
  );
  // Adding windows lives in the toolbar's icon bar, so the composer row is the composer alone.
  const composerRow = <div className="wall-composer-row" data-dock={`${wall.composer.side}-${wall.composer.align}`}>{composer}</div>;
  // Changes, Browser and Files open in the selected agent's workspace, which
  // the wall shows as companions under its window: unfold them so they show.
  // Companions open from each agent's own header now; unfold that agent's
  // companions on the wall so the one just opened is visible.
  useEffect(() => {
    const opened = (e: Event) => {
      const id = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (id) setWall((w) => (w.folded[id] === false ? w : { ...w, folded: { ...w.folded, [id]: false } }));
    };
    window.addEventListener(COMPANION_OPENED_EVENT, opened);
    return () => window.removeEventListener(COMPANION_OPENED_EVENT, opened);
  }, [setWall]);

  return (
    <div ref={viewRef} className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-1 xl:px-6">
      <WallToolbar wall={wall} setWall={setWall} onAutoArrange={autoArrange} addOpen={addOpen} setAddOpen={setAddOpen}
        onAdd={(kind) => { setCompletedId(null); void addFromToolbar(kind); }} />
      <div className="wall-workspace" data-dock-side={wall.dock.side}>
        <WallDock state={wall} setState={setWall} tasks={tasks} running={running} now={now} sessions={sessions} providers={providers} usage={usage} vitals={vitals} onOpenChat={openChat} onOpenModels={() => setView('models')} />
        <div className="wall-agent-workspace" data-tabs={panel.show && panel.orientation === 'horizontal' ? 'top' : 'left'}>
      {!panel.show && <div className="agent-panel-collapsed" data-orientation={panel.orientation}>
        <AgentPanelControls show={false} orientation={panel.orientation}
          onToggle={() => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), show: true } }))}
          onOrientation={(orientation) => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), orientation } }))} />
      </div>}
      {panel.show && <AgentSidebar onCreate={async (kind, projectId, shell) => {
        const id = kind === 'terminal' ? await newTerminal(projectId, shell) : await newChat({ kind: 'chat', chatType: kind === 'image' ? 'image' : 'multimodal' }, projectId);
        await addFromToolbar(kind === 'terminal' ? 'terminal' : 'chat', id);
        setCompletedId(null);
      }} selectedId={completedId ?? selected} onOpenChat={(id) => {
        if (sessions.find((session) => session.id === id)?.archivedAt) setCompletedId(id);
        else {
          setCompletedId(null);
          // Focus shows the chosen chat. Every other layout keeps its windows
          // and marks the chat's window active, adding one when it has none.
          void addFromToolbar('chat', id);
          selectAgent(id);
          if (wall.layout.mode === 'focus') setWall((w) => ({ ...w, hero: id }));
        }
      }} onOpenTerminal={(id) => { setCompletedId(null); void addFromToolbar('terminal', id); }}
        orientation={panel.orientation}
        onOrientation={(orientation) => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), orientation } }))}
        onClosePanel={() => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), show: false } }))} />}
      <div className="wall-column">
      {!completedId && wall.layout.mode !== 'focus' && wall.composer.side === 'top' && composerRow}
      {completedId ? <div className="panel panel-ring flex min-h-0 flex-1 flex-col overflow-hidden"><button className="btn btn-ghost self-start" onClick={() => setCompletedId(null)}>Back to active agents</button><ChatPane key={completedId} sessionId={completedId} readOnly /></div> : <CommandWall
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
      />}
      {!completedId && wall.layout.mode !== 'focus' && wall.composer.side === 'bottom' && composerRow}
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

export function WallToolbar({
  wall,
  setWall,
  onAutoArrange,
  addOpen,
  setAddOpen,
  onAdd,
}: {
  wall: CommandWallState;
  setWall: (update: (s: CommandWallState) => CommandWallState) => void;
  onAutoArrange: () => void;
  addOpen: boolean;
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** A new agent or terminal window on the wall. */
  onAdd: (kind: 'chat' | 'terminal') => void;
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
  const panel = readAgentPanel(wall.agentPanel);
  // In the desktop shell the controls share the title bar's row with the
  // Agents heading instead of costing a row of their own.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!hasAppChrome) return;
    // The native title bar is one row; narrow windows keep controls in-view.
    const wide = window.matchMedia('(min-width: 1100px)');
    // Recover if chrome remounts or replaces the portal host during navigation.
    // Watch only the host's direct ancestors (childList, no subtree): a whole-body
    // subtree observer also saw every streamed transcript node on the wall.
    const observer = new MutationObserver(() => update());
    const update = () => {
      const host = document.getElementById('command-titlebar-slot');
      setSlot(wide.matches ? host : null);
      observer.disconnect();
      let ancestor: HTMLElement | null = host?.parentElement ?? document.body;
      while (ancestor) {
        observer.observe(ancestor, { childList: true });
        ancestor = ancestor.parentElement;
      }
    };
    update();
    wide.addEventListener('change', update);
    return () => { wide.removeEventListener('change', update); observer.disconnect(); };
  }, []);

  const controls = (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${slot ? 'wall-toolbar-titlebar' : ''}`} data-wall-toolbar>
      {!hasAppChrome && <h1 className="view-title text-gradient">Agents</h1>}
      <div className={`ml-auto flex flex-wrap items-center ${slot ? 'gap-2' : 'gap-3'}`}>

        {/* Adding to the wall, first in the row: an agent or a terminal of its
            own. An agent's Changes, Files and Browser live in that agent's own
            header beside Logs. More opens the full picker. */}
        <div className="wall-add-bar" role="group" aria-label="Add to the wall">
          <button type="button" className="wall-add-icon" title="New agent" aria-label="New agent" onClick={() => onAdd('chat')}><NekkoAvatar size={16} stationary eyes={false} /></button>
          <button type="button" className="wall-add-icon" title="New terminal" aria-label="New terminal" onClick={() => onAdd('terminal')}><TerminalIcon className="h-4 w-4" /></button>
          <button
            type="button"
            className="wall-add-icon"
            data-wall-add-button
            onClick={() => {
              if (!addOpen) setWall((w) => w.layout.mode === 'focus' ? { ...w, layout: { ...w.layout, mode: 'grid' } } : w);
              setAddOpen((o) => !o);
            }}
            aria-controls="wall-window-picker"
            aria-expanded={addOpen}
            aria-label="Add window"
            title="More: a chat already running, an image session, or a new chat with details"
          >
            <MoreVerticalIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="wall-layout-control" ref={fixedRef}>
          <div className="wall-layout-segments" role="group" aria-label="Wall layout">
            {(['focus', 'grid', 'fixed'] as const).map((mode) => (
              <button key={mode} type="button" title={`${LAYOUT_LABEL[mode]} (${layoutShortcutLabel(mode)})`} aria-pressed={wall.layout.mode === mode} aria-expanded={mode === 'fixed' ? fixedOpen : undefined} onClick={() => {
                if (mode === 'fixed') { setHoverSize({ rows: wall.layout.rows, cols: wall.layout.cols }); setFixedOpen((open) => !open); }
                else { setFixedOpen(false); setWall((w) => ({ ...w, layout: { ...w.layout, mode } })); }
              }}>{React.createElement(mode === 'focus' ? FocusLayoutIcon : mode === 'grid' ? GridIcon : FixedLayoutIcon, { className: 'h-4 w-4' })}{LAYOUT_LABEL[mode]}</button>
            ))}
          </div>
          <div className="wall-auto-arrange" data-visible={wall.layout.mode === 'grid'}>
            <button type="button" className="btn btn-outline py-1 disabled:opacity-50" title="Auto-arrange: fit windows above the composer in even rows and columns" aria-label="Auto-arrange" aria-describedby={wall.layout.mode === 'grid' ? 'wall-auto-arrange-tip' : undefined} tabIndex={wall.layout.mode === 'grid' ? 0 : -1} onClick={onAutoArrange} disabled={!canArrange}>
              <WandIcon className="h-4 w-4" />
            </button>
            <span id="wall-auto-arrange-tip" role="tooltip">Fit windows above the composer in even rows and columns.</span>
          </div>
          {fixedOpen && <div className="wall-fixed-picker" role="dialog" aria-label="Grid size">
            <p className="wall-fixed-shortcut">{layoutShortcutLabel('fixed')} · Grid view</p>
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
        <button type="button" className="btn btn-outline gap-1.5 py-1 text-[12px]" aria-pressed={wall.dock.show} onClick={() => setWall((w) => ({ ...w, dock: { ...w.dock, show: !w.dock.show } }))}><PanelIcon className="h-4 w-4" />Panels</button>
      </div>
    </div>
  );
  return slot ? createPortal(controls, slot) : controls;
}
