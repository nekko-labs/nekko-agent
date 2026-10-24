import { AgentWindowDropdown, defaultFolderIds, type AgentWindowSelection } from '../components/AgentWindowPicker.js';
import { AgentSidebar } from './WorkspacesView.js';
import { ChatPane } from '../components/ChatPane.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, AutomationTask, PendingInput, SessionSummary, UsageSummary } from '@nekko-agent/shared';
import type { AgentType } from '@nekko-agent/shared';
import { AUTO_MODEL_ID, classifyAgent, classifySession, formatUSD } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { addCreatedSession, useStore } from '../store.js';
import { putCachedSession } from '../sessionCache.js';
import { newAgentSetup } from '../newAgentSetup.js';
import { runningSessionIds } from '../liveRuns.js';
import { PhotoIcon, TerminalIcon, FocusLayoutIcon, BoltIcon, MagnetIcon } from '../icons.js';
import { HoverTip } from '../components/HoverTip.js';
import { NekkoAvatar } from '../components/Mascot.js';
import { AgentPanelControls } from '../components/AgentPanelControls.js';
import { CommandWall } from '../components/CommandWall.js';
import { WallComposer, type WallAgent } from '../components/WallComposer.js';
import { agentStatusOfLane } from '../components/WorkspaceCard.js';
import { BLOCKED_META, LANE_META, sessionLane } from '@nekko-agent/shared';
import { type Vitals } from '../components/InsightsBox.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { MonitorsDock } from '../components/MonitorsDock.js';
import { usePanelPresence } from '../usePanelPresence.js';
import { hasAppChrome } from '../chrome.js';
import { claimAgent, displaysBridge, isScreenWindow, useDisplays, wallStorageKey, windowKey } from '../displays.js';
import { ScreensControl } from '../components/ScreensControl.js';
import { needsProviderSetup } from '../components/providers/providerSetup.js';
import { reusableEmptyChat, shouldStartFromEmptyWall } from '../emptyWallStart.js';

import { allPanes, type PaneKind } from '../layout.js';
import {
  applySnap,
  DEFAULT_ASPECT,
  openWallPane,
  loadWallState,
  nextAgent,
  reconcileWall,
  readAgentPanel,
  wallAgents,
  saveWallState,
  toWallSetting,
  type CommandWallState,
} from '../commandWall.js';

const HOUR = 60 * 60_000;

/**
 * The wall's storage as this window should see it: the main window reads and
 * writes the original keys; a second screen's window keeps its own copy, so
 * two walls never overwrite each other.
 */
function screenStorage(storage: Storage | undefined): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  if (!storage || !isScreenWindow) return storage;
  return {
    getItem: (key) => storage.getItem(wallStorageKey(key)),
    setItem: (key, value) => storage.setItem(wallStorageKey(key), value),
  };
}

/** Physical digits also work when Shift produces !, @, or #. */
export function wallLayoutShortcut(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>) {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.altKey || !e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey)) return null;
  const digit = /^Digit[12]$/.test(e.code) ? e.code.slice(-1) : /^[12]$/.test(e.key) ? e.key : null;
  return digit === '1' ? 'focus' : digit === '2' ? 'grid' : null;
}

/**
 * What each saved layout mode is called. The tiled wall reads as Dynamic
 * (even rows and columns are its Fixed grid setting). Saved values keep their
 * original keys so existing walls load unchanged.
 */
export const LAYOUT_LABEL: Record<'focus' | 'grid', string> = { focus: 'Focused', grid: 'Dynamic' };

function layoutShortcutLabel(mode: 'focus' | 'grid') {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return `${mac ? '⌘' : 'Ctrl'}+Shift+${mode === 'focus' ? 1 : 2}`;
}

/**
 * The Agent board: every agent and terminal as a live window on one wall,
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
  // A second screen's window (multi-monitor) keeps a wall of its own in this
  // browser's storage and leaves the shared wall setting to the main window.
  const storage = useMemo(() => screenStorage(typeof localStorage === 'undefined' ? undefined : localStorage), []);
  const [wall, setWallState] = useState<CommandWallState>(() => {
    const loaded = loadWallState(storage, isScreenWindow ? null : useStore.getState().settings?.commandWall);
    // A new screen starts empty (it is where new agents go first), not
    // seeded with the recent chats the main wall already shows.
    return isScreenWindow && loaded.watermark === 0 ? { ...loaded, root: null, watermark: Date.now() } : loaded;
  });
  // Every change goes through snap: while it is on, the wall stays evenly spaced.
  const setWall = useCallback((update: (s: CommandWallState) => CommandWallState) => setWallState((s) => applySnap(s, update(s))), []);
  const firstSave = useRef(true);
  // The wall waiting to reach the host. Leaving the page or closing the app
  // inside the settle delay used to drop it, and the next load preferred the
  // host's older copy: a composer resized just before switching tabs came
  // back at its old size.
  const unsaved = useRef<CommandWallState | null>(null);
  const flushWall = useCallback(() => {
    const pending = unsaved.current;
    if (!pending) return;
    unsaved.current = null;
    if (isScreenWindow) return;
    const setting = toWallSetting(pending);
    useStore.setState((s) => (s.settings ? { settings: { ...s.settings, commandWall: setting } } : {}));
    window.nekko.updateSettings({ commandWall: setting }).catch(() => {});
  }, []);
  useEffect(() => {
    saveWallState(storage, wall);
    // The first run is the load itself; after that, every change goes to the
    // host a moment after it settles (a divider drag is many changes a second).
    if (firstSave.current) { firstSave.current = false; return; }
    unsaved.current = wall;
    const t = setTimeout(flushWall, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall]);
  useEffect(() => {
    window.addEventListener('beforeunload', flushWall);
    return () => { window.removeEventListener('beforeunload', flushWall); flushWall(); };
  }, [flushWall]);
  // The stage's shape, as the wall measures it, for placing windows nobody
  // pointed at a side for: beside the biggest window, along its longer side.
  const aspectRef = useRef(DEFAULT_ASPECT);
  const onAspect = useCallback((a: number) => { aspectRef.current = a; }, []);
  // Not before both lists have loaded once: reconciling against the empty
  // lists the view mounts with would seed an empty wall and watermark every
  // chat that already exists out of it.
  const [listsReady, setListsReady] = useState(false);
  // Multi-monitor: which window owns each chat that appeared since the wall
  // last looked, resolved before reconciling so a new chat lands on exactly
  // one screen's wall. With one screen every chat is this window's at once.
  const owners = useRef(new Map<string, string>());
  const [ownersVersion, setOwnersVersion] = useState(0);
  const [displays] = useDisplays();
  const multiScreen = (displays?.displays.filter((d) => d.enabled).length ?? 1) > 1;
  useEffect(() => {
    if (!listsReady || !multiScreen || wall.watermark === 0) return;
    const fresh = sessions.filter((s) => s.createdAt > wall.watermark && !s.parentSessionId && !owners.current.has(s.id));
    if (!fresh.length) return;
    let live = true;
    void Promise.all(fresh.map(async (s) => { owners.current.set(s.id, await claimAgent(s.id, 'auto')); }))
      .then(() => { if (live) setOwnersVersion((v) => v + 1); });
    return () => { live = false; };
  }, [listsReady, multiScreen, sessions, wall.watermark]);
  useEffect(() => {
    if (!listsReady) return;
    if (!multiScreen) { setWallState((w) => applySnap(w, reconcileWall(w, sessions, terminals, Date.now(), aspectRef.current))); return; }
    // A chat whose owner is not known yet is left out (it would move the
    // watermark past it); it is looked at again once its claim answers.
    setWallState((w) => {
      const known = sessions.filter((s) => w.watermark === 0 || s.createdAt <= w.watermark || s.parentSessionId || owners.current.has(s.id));
      return applySnap(w, reconcileWall(w, known, terminals, Date.now(), aspectRef.current, (id) => owners.current.get(id) === windowKey));
    });
  }, [listsReady, sessions, terminals, ownersVersion, multiScreen]);
  // Main placed a chat made in another window here: open it on this wall.
  useEffect(() => displaysBridge?.onPlaced((id) => {
    owners.current.set(id, windowKey);
    setWallState((w) => applySnap(w, openWallPane(w, 'chat', id, aspectRef.current)));
  }), []);
  // Tell main how full this wall is, for "prioritize empty windows".
  const paneCount = useMemo(() => allPanes(wall.root).length, [wall.root]);
  useEffect(() => { displaysBridge?.report(paneCount); }, [paneCount]);

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
        // Each call is a host round trip before the window can open, so skip
        // the ones that would change nothing on a just-created chat.
        const needs = newAgentSetup(s, selection);
        const chatType = selection.chatType ?? 'multimodal';
        if (needs.options) {
          const updated = await window.nekko.setSessionOptions(s.id, { chatType, ...(selection.providerId ? { providerId: selection.providerId } : {}), ...(selection.modelId ? { modelId: selection.modelId, autoModel: selection.modelId === AUTO_MODEL_ID } : {}) });
          if (!updated) throw new Error('Could not configure the new agent window.');
          s = updated;
        }
        if (needs.supporting) {
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
    // The host returned the full record: cached, the window's first frame is
    // the finished chat, not a placeholder swapped out mid-reveal.
    putCachedSession(s);
    addCreatedSession(s);
    return s.id;
  };
  const newTerminal = async (workspaceId = activeProjectId ?? undefined, shell?: string): Promise<string> => {
    const t = await window.nekko.createTerminal({ workspaceId, shell });
    useStore.setState((state) => ({ terminals: [t, ...state.terminals.filter((existing) => existing.id !== t.id)] }));
    return t.id;
  };
  /**
   * Multi-monitor: where a chat this window just made goes. A screen window
   * keeps what it makes; the main window follows the placement preference
   * (an empty screen first, or itself first). True when it stays here.
   */
  const keepNewChat = async (id: string): Promise<boolean> => {
    if (!multiScreen) return true;
    const owner = await claimAgent(id, isScreenWindow ? 'self' : 'place');
    owners.current.set(id, owner);
    return owner === windowKey;
  };
  /** A window from the toolbar, with no side pointed at: beside the biggest window. */
  const addFromToolbar = async (kind: PaneKind, refId?: string, created = false) => {
    const fresh = kind === 'chat' && (created || !refId);
    const ref = refId ?? (kind === 'chat' ? await newChat() : kind === 'terminal' ? await newTerminal() : kind);
    // Placed on another screen: that window opens it; nothing to add here.
    if (fresh && !(await keepNewChat(ref))) return;
    setWall((w) => openWallPane(w, kind, ref, aspectRef.current));
    if (kind === 'chat') setSelected(ref);
  };
  /** A one-click add that failed says so, instead of silently opening nothing. */
  const reportAddFailure = (e: unknown) => useStore.getState().pushToast('error', `Could not add the window: ${e instanceof Error ? e.message : String(e)}`);

  // The agent the composer speaks for: the window clicked last, or the first
  // on the wall. Ctrl+Tab / Ctrl+Shift+Tab walk the windows in reading order;
  // Ctrl+1…9 (or Alt+1…9) pick one by its number.
  const [addOpen, setAddOpen] = useState(false);
  const [completedId, setCompletedId] = useState<string | null>(null);
  // The reader shows a completed chat only while it stays completed: restoring
  // or deleting it (from its bar or the agent list's menu) closes the reader.
  useEffect(() => {
    if (completedId && listsReady && !sessions.some((s) => s.id === completedId && s.archivedAt)) setCompletedId(null);
  }, [completedId, listsReady, sessions]);
  const [selected, setSelected] = useState<string | null>(() => wall.hero);
  const selectAgent = useCallback((id: string | null) => {
    setCompletedId(null);
    setSelected(id);
    setWall((w) => w.hero === id ? w : { ...w, hero: id });
  }, [setWall]);
  // Another tab (Artifacts) asked to show a chat here, Focused. Waits for the
  // lists so the chat is known; a completed chat opens read-only, as the
  // agent panel opens one.
  const focusRequest = useStore((s) => s.focusRequest);
  useEffect(() => {
    if (!focusRequest || !listsReady) return;
    useStore.setState({ focusRequest: null });
    const { sessionId, keepLayout } = focusRequest;
    const chat = sessions.find((s) => s.id === sessionId);
    if (!chat) { useStore.getState().pushToast('error', 'That chat no longer exists.'); return; }
    if (chat.archivedAt) { setCompletedId(chat.id); return; }
    setCompletedId(null);
    setWall((w) => {
      const opened = openWallPane(w, 'chat', chat.id, aspectRef.current);
      return keepLayout || opened.layout.mode === 'focus' ? opened : { ...opened, layout: { ...opened.layout, mode: 'focus' } };
    });
    setSelected(chat.id);
  }, [focusRequest, listsReady, sessions, setWall]);
  const agentsOnWall = useMemo(() => wallAgents(wall.root), [wall.root]);
  const panel = readAgentPanel(wall.agentPanel);
  const agentsPresent = usePanelPresence(panel.show);
  useEffect(() => {
    if (agentsOnWall.length === 0) { if (selected) setSelected(null); return; }
    if (!selected || !agentsOnWall.some((p) => p.refId === selected)) setSelected(agentsOnWall.find((p) => p.refId === wall.hero)?.refId ?? agentsOnWall[0].refId);
  }, [agentsOnWall, selected, wall.hero]);
  // An empty wall is the new-chat screen: Focused on an untouched chat (reused
  // when one exists, so emptying the wall again never piles up blank chats).
  // One attempt at a time; a failure is reported once and not retried until
  // the wall has had a window again.
  const startingEmpty = useRef(false);
  const emptyStartFailed = useRef(false);
  if (paneCount > 0) emptyStartFailed.current = false;
  useEffect(() => {
    const { activeModelId, models } = useStore.getState();
    const providerReady = !needsProviderSetup(providers, activeModelId ?? models[0]?.id);
    if (startingEmpty.current || emptyStartFailed.current) return;
    if (!shouldStartFromEmptyWall({ listsReady, hasWindows: paneCount > 0, screenWindow: isScreenWindow, readingCompleted: !!completedId, providerReady })) return;
    startingEmpty.current = true;
    void (async () => {
      const reuse = reusableEmptyChat(sessions);
      const id = reuse ?? await newChat();
      // Placed on another screen by the placement preference: that window shows it.
      // Do not try again here, or every session refresh would make another chat.
      if (!reuse && !(await keepNewChat(id))) { emptyStartFailed.current = true; return; }
      setWall((w) => {
        const opened = openWallPane(w, 'chat', id, aspectRef.current);
        return { ...opened, hero: id, layout: { ...opened.layout, mode: 'focus' } };
      });
      setSelected(id);
    })().catch((e) => { emptyStartFailed.current = true; reportAddFailure(e); }).finally(() => { startingEmpty.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listsReady, paneCount, completedId, providers, sessions]);
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
  // The dragged height is saved with the wall (like the dock and width), so
  // it is still there after visiting another page or restarting the app.
  const composerHeight = wall.composer.height ?? null;
  const setComposerHeight = useCallback((height: number | null) => setWall((w) => {
    const next = height === null ? undefined : Math.round(height);
    if (w.composer.height === next) return w;
    const { height: _old, ...rest } = w.composer;
    return { ...w, composer: next === undefined ? rest : { ...rest, height: next } };
  }), [setWall]);
  const setComposerWidth = useCallback((width: number | null) => setWall((w) => {
    const next = width === null ? undefined : Math.round(width);
    if (w.composer.width === next) return w;
    const { width: _old, ...rest } = w.composer;
    return { ...w, composer: next === undefined ? rest : { ...rest, width: next } };
  }), [setWall]);
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  // The composer's natural (unsized) height, remembered whenever it is at its
  // default so a drag can snap back to it.
  const composerDefaultH = useRef<number | null>(null);
  useLayoutEffect(() => { if (composerHeight === null && composerRef.current) composerDefaultH.current = composerRef.current.offsetHeight; });
  // Two snap points while dragging: the default size and full size (the 70% cap).
  const snapComposerHeight = (raw: number) => {
    const available = composerRef.current?.closest('.wall-column')?.clientHeight ?? 700;
    const max = available * .7;
    const h = Math.max(120, Math.min(max, raw));
    const def = composerDefaultH.current;
    if (def !== null && Math.abs(h - def) <= 24) return null;
    if (max - h <= 24) return max;
    return h;
  };
  const composerSplit = <div className="wall-composer-split" role="separator" tabIndex={0} aria-label="Resize composer versus wall" aria-orientation="horizontal" title="Drag to resize composer versus wall; double-click to reset"
    onPointerDown={(e) => { composerDrag.current = { y: e.clientY, height: composerRef.current?.offsetHeight ?? 240 }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { const drag = composerDrag.current; if (!drag) return; setComposerHeight(snapComposerHeight(drag.height + (e.clientY - drag.y) * (wall.composer.side === 'top' ? 1 : -1))); }}
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
      onDock={(dock) => setWall((w) => ({ ...w, composer: { ...w.composer, side: dock.side, align: dock.align } }))}
      onWidth={setComposerWidth}
      onSelect={selectAgent}
      onOpen={openChat}
      onFocus={(id) => {
        selectAgent(id);
        setWall((w) => ({ ...w, hero: id, layout: { ...w.layout, mode: 'focus' } }));
      }}
      onNewAgent={() => { void addFromToolbar('chat').catch(reportAddFailure); }}
      panelRef={composerRef}
    />
  );
  // Adding windows lives in the toolbar's icon bar, so the composer row is the composer alone.
  const composerRow = <div className="wall-composer-row" data-dock={`${wall.composer.side}-${wall.composer.align}`}>{composer}</div>;

  return (
    <div ref={viewRef} className="flex h-full min-h-0 flex-col gap-2 pb-1.5 pl-[3px] pr-px pt-1">
      <WallToolbar wall={wall} setWall={setWall} addOpen={addOpen} setAddOpen={setAddOpen}
        onAdd={(kind) => {
          setCompletedId(null);
          const add = kind === 'image' ? newChat({ kind: 'chat', chatType: 'image' }).then((id) => addFromToolbar('chat', id, true)) : addFromToolbar(kind);
          void add.catch(reportAddFailure);
        }}
        onPick={async (selection) => {
          const ref = selection.refId ?? (selection.kind === 'chat' ? await newChat(selection) : await newTerminal());
          await addFromToolbar(selection.kind, ref, !selection.refId);
          // Unless placement sent the new agent to another screen.
          if (selection.kind === 'chat' && (owners.current.get(ref) ?? windowKey) === windowKey) selectAgent(ref);
          setCompletedId(null);
          setAddOpen(false);
        }} />
      <div className="wall-workspace" data-dock-side={wall.dock.side}>
        <MonitorsDock state={wall} setState={setWall} tasks={tasks} running={running} now={now} sessions={sessions} providers={providers} usage={usage} vitals={vitals} onOpenChat={openChat} onOpenModels={() => setView('models')} />
        <div className="wall-agent-workspace" data-tabs={agentsPresent && panel.orientation === 'horizontal' ? 'top' : 'left'}>
      {!panel.show && <div className="agent-panel-collapsed" data-orientation={panel.orientation}>
        <AgentPanelControls show={false} orientation={panel.orientation}
          onToggle={() => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), show: true } }))}
          onOrientation={(orientation) => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), orientation } }))} />
      </div>}
      {agentsPresent && <div className="wall-agents-presence" data-orientation={panel.orientation} data-panel-open={panel.show} inert={!panel.show} aria-hidden={!panel.show}><AgentSidebar onCreate={async (kind, projectId, shell) => {
        const id = kind === 'terminal' ? await newTerminal(projectId, shell) : await newChat({ kind: 'chat', chatType: kind === 'image' ? 'image' : 'multimodal' }, projectId);
        await addFromToolbar(kind === 'terminal' ? 'terminal' : 'chat', id, true);
        setCompletedId(null);
      }} selectedId={completedId ?? selected} onOpenChat={(id) => {
        if (sessions.find((session) => session.id === id)?.archivedAt) setCompletedId(id);
        else {
          setCompletedId(null);
          // Focus shows the chosen chat. Every other layout keeps its windows
          // and marks the chat's window active, adding one when it has none.
          // One guarded wall update, so reselecting the active chat changes nothing.
          void addFromToolbar('chat', id);
        }
      }} onOpenTerminal={(id) => { setCompletedId(null); void addFromToolbar('terminal', id); }}
        orientation={panel.orientation}
        onOrientation={(orientation) => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), orientation } }))}
        onClosePanel={() => setWall((w) => ({ ...w, agentPanel: { ...readAgentPanel(w.agentPanel), show: false } }))} /></div>}
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
      />}
      {!completedId && wall.layout.mode !== 'focus' && wall.composer.side === 'bottom' && composerRow}
        </div>
      </div>
      </div>
    </div>
  );
}

/* ---------- toolbar ---------- */

export function WallToolbar({
  wall,
  setWall,
  addOpen,
  setAddOpen,
  onAdd,
  onPick,
}: {
  wall: CommandWallState;
  setWall: (update: (s: CommandWallState) => CommandWallState) => void;
  addOpen: boolean;
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** A new agent, image session or terminal window on the wall. */
  onAdd: (kind: 'chat' | 'image' | 'terminal') => void;
  onPick?: (selection: AgentWindowSelection) => Promise<void>;
}) {
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const snapOn = !!wall.snap;
  const snapAvailable = wall.layout.mode === 'grid' && !wall.layout.fixedGrid;
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

        {/* Adding to the wall, first in the row: an agent, an image session or a
            terminal of its own. An agent's Changes, Files and Browser live in that agent's own
            header beside Logs. The empty wall can still open the full picker. */}
        <div className="wall-add-bar" role="group" aria-label="Add to the wall">
          <button type="button" className="wall-add-icon" title="New agent" aria-label="New agent" onClick={() => onAdd('chat')}><NekkoAvatar size={16} stationary eyes={false} /></button>
          <button type="button" className="wall-add-icon" title="New image session" aria-label="New image session" onClick={() => onAdd('image')}><PhotoIcon className="h-4 w-4" /></button>
          <button type="button" className="wall-add-icon" title="New terminal" aria-label="New terminal" ref={addButtonRef} onClick={() => onAdd('terminal')}><TerminalIcon className="h-4 w-4" /></button>
        </div>
        {addOpen && onPick && <AgentWindowDropdown anchorRef={addButtonRef} onClose={() => setAddOpen(false)} onAdd={onPick} />}
        <div className="wall-layout-control">
          <div className="wall-layout-segments" role="group" aria-label="Wall layout">
            {(['focus', 'grid'] as const).map((mode) => (
              <button key={mode} type="button" title={`${LAYOUT_LABEL[mode]} (${layoutShortcutLabel(mode)})`} aria-pressed={wall.layout.mode === mode} onClick={() => setWall((w) => ({ ...w, layout: { ...w.layout, mode } }))}>{React.createElement(mode === 'focus' ? FocusLayoutIcon : BoltIcon, { className: 'h-4 w-4' })}{LAYOUT_LABEL[mode]}</button>
            ))}
          </div>
          {/* Snap to grid, only in free-form Dynamic (a Fixed grid is already
              even). Its space stays reserved so revealing it never shifts the controls. */}
          <div className="wall-auto-arrange" data-visible={snapAvailable}>
            <HoverTip label={snapOn ? 'Snap to grid is on: windows stay evenly spaced' : 'Snap to grid: keep windows evenly spaced'}>
              <button type="button" className="wall-snap-toggle" aria-label="Snap to grid" aria-pressed={snapOn}
                tabIndex={snapAvailable ? 0 : -1} disabled={!snapAvailable}
                onClick={() => setWall((w) => ({ ...w, snap: !w.snap }))}>
                <MagnetIcon className="h-4 w-4" />
              </button>
            </HoverTip>
          </div>
        </div>
        {/* Multi-monitor: Dynamic mode only, at the end of the toolbar (the
            Monitors toggle now lives in the panel's own header). */}
        {wall.layout.mode === 'grid' && <ScreensControl />}
      </div>
    </div>
  );
  return slot ? createPortal(controls, slot) : controls;
}
