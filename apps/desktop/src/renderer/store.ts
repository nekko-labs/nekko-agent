import { needsProviderSetup } from './components/providers/providerSetup.js';
import { create } from 'zustand';
import type { AppSettings, Session, SessionSummary, ProviderConfig, ModelInfo, TerminalInfo, InstalledSkillRecord, SkillDef, PrInfo, HypergateInfo } from '@nekko-agent/shared';
import { DEFAULT_IMAGE_CHAT_PARAMS, isArchived, getMarketSkill, marketToSkillDef, normalizeInstallTarget, summarizeSession, THEME_PRESETS, currentPresetAccent } from '@nekko-agent/shared';
import type { MascotMood } from './components/Mascot.js';
import { syncTitleBarOverlay } from './chrome.js';
import { putCachedSession } from './sessionCache.js';
import { loadLayout, maxIdSeq, pruneLayout, saveLayout } from './workspacePersist.js';
import {
  allPanes,
  canSplit,
  findPane,
  findPaneByRef,
  movePane as moveInTree,
  swapPanes as swapInTree,
  newPaneId,
  removePane,
  reserveIdSeq,
  resizeSplit,
  retargetPane as retargetInTree,
  splitPane as splitInTree,
  type Direction,
  type PaneKind,
  type WbNode,
  type WbPane,
} from './layout.js';

export type { Direction, PaneKind, WbNode, WbPane } from './layout.js';

export type View = 'command' | 'chat' | 'models' | 'modelserver' | 'connectors' | 'memory' | 'settings' | 'design' | 'skills' | 'training' | 'workflows';

/**
 * Nav destinations that live behind a Settings → Experimental toggle. The flag
 * names deliberately match the view ids so `settings.experimental[v]` reads
 * directly.
 */
export const EXPERIMENTAL_VIEWS = ['training', 'design', 'memory'] as const;
export type ExperimentalView = (typeof EXPERIMENTAL_VIEWS)[number];

/**
 * The folder a chat works in, as the Files companion should open it: the
 * chat's own checkout of its primary folder when it has one (that is where the
 * agent is editing), else the primary folder, else its first supporting
 * folder. Empty when the chat has no folder, which the explorer turns into a
 * folder chooser.
 */
export function chatFolderPath(s: { sessions: SessionSummary[]; settings: AppSettings | null }, sessionId: string, full?: Pick<Session, 'workspaceId' | 'supportingWorkspaceIds' | 'gitWorktrees'> | null): string {
  const chat = full ?? s.sessions.find((x) => x.id === sessionId);
  const folders = s.settings?.workspaces ?? [];
  const primary = chat?.workspaceId;
  if (primary) {
    const checkout = chat?.gitWorktrees?.[primary]?.path;
    if (checkout) return checkout;
    const path = folders.find((w) => w.id === primary)?.path;
    if (path) return path;
  }
  for (const id of chat?.supportingWorkspaceIds ?? []) {
    const path = folders.find((w) => w.id === id)?.path;
    if (path) return path;
  }
  return '';
}

/**
 * Whether a nav destination is reachable. Chat needs its Developer flag and
 * experimental views need their flag on; everything else is always available.
 * Settings that haven't loaded yet
 * count as all-flags-off.
 */
export function viewEnabled(view: View, settings: AppSettings | null | undefined): boolean {
  if (view === 'chat') return settings?.developer?.chat === true;
  if (!(EXPERIMENTAL_VIEWS as readonly string[]).includes(view)) return true;
  return settings?.experimental?.[view as ExperimentalView] === true;
}

/**
 * Should the setup wizard open itself once settings load?
 *
 * `onboarding.completedAt` is unset on every install that predates the
 * wizard, so gating on the flag alone would ambush existing users with a
 * full-screen takeover on upgrade. A configured provider is the strongest
 * "setup already happened" signal we have, so the wizard auto-opens only on a
 * genuinely fresh install; everyone else can reach it from Settings → Replay
 * setup.
 */
export function shouldAutoOpenOnboarding(settings: AppSettings | null | undefined): boolean {
  if (!settings || settings.onboarding?.completedAt) return false;
  return (settings.providers?.length ?? 0) === 0;
}

/** A message routed into a chat's composer from another surface (editor comment, design note). */
export interface ComposerInbox {
  sessionId: string;
  text: string;
  /** true = send immediately ("Run now"); false = drop into the draft ("Add to prompt"). */
  run: boolean;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
}

/**
 * One workspace: a named arrangement of windows you switch to as a whole.
 *
 * Each card in the left sidebar is one of these. A workspace is opened around
 * something — usually the chat that started the work — and grows whatever
 * windows that work needs: the file the agent touched, a terminal, a browser, a
 * second agent. Its `root` is a split tree (see layout.ts), so every window in
 * it is on screen at once and switching workspaces swaps the whole arrangement
 * rather than one tab.
 */
export interface Workspace {
  id: string;
  /**
   * What the workspace is about, and what its sidebar card reports on. Kept
   * even if that window is closed, so a workspace never loses its identity
   * mid-session.
   */
  anchor: { kind: PaneKind; refId: string };
  root: WbNode | null;
  /** The window keyboard input and "open here" actions go to. */
  activePaneId: string | null;
}

const PLAN_RAIL_KEY = 'nekko.planRail';

/**
 * The rail's remembered state. On by default; the chat pane hides it anyway when
 * the pane it is in has no room, so this only records what you asked for.
 */
function readPlanRailOpen(): boolean {
  try {
    const saved = localStorage.getItem(PLAN_RAIL_KEY);
    if (saved != null) return saved === '1';
  } catch { /* private mode */ }
  return true;
}

export const LAST_FOLDER_KEY = 'nekko.lastPrimaryFolder';
export function readLastFolder(): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_FOLDER_KEY) ?? 'null');
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

// The open workspaces come back from the last run (see workspacePersist.ts).
// Both id counters restart at zero each launch, so they skip past every id
// the restored layout already uses.
const restored = loadLayout(typeof window === 'undefined' ? undefined : window.localStorage);
let wsSeq = maxIdSeq(restored.workspaces);
reserveIdSeq(wsSeq);
const newWorkspaceId = () => `ws_${(++wsSeq).toString(36)}`;

interface UiState {
  settings: AppSettings | null;
  view: View;
  /**
   * Every chat, without transcripts (see SessionSummary). A chat pane fetches
   * its own transcript through the session cache.
   */
  sessions: SessionSummary[];
  sessionCtxEstimate: Record<string, number>;
  setSessionCtxEstimate: (sessionId: string, tokens: number | null) => void;
  activeSessionId: string | null;
  providers: ProviderConfig[];
  models: ModelInfo[];
  activeProviderId: string | null;
  activeModelId: string | null;
  contextPanelOpen: boolean;
  /**
   * Whether the chat pane shows its plan / sub-agent rail. App-wide rather than
   * per-chat, like the context panel: it's a way of working, not a property of
   * one conversation.
   */
  planRailOpen: boolean;
  /** Whether the first-run setup wizard is showing over the app. */
  onboardingOpen: boolean;
  /** True after the first settings load has finished. */
  settingsLoaded: boolean;
  mascotMood: MascotMood;
  toasts: Toast[];
  paletteOpen: boolean;
  /**
   * The project folder new work is filed under. Named for the folder, not for
   * the workspaces below it: `settings.workspaces` is the folder list the rest
   * of the app has always called projects in the UI, and a `Workspace` here is
   * the arrangement of windows on screen.
   */
  activeProjectId: string | null;

  /**
   * Where the chat's full monitoring section sits on screen (null when it isn't
   * mounted). The floating monitor chip reads this so it can fly into the
   * section instead of covering it.
   */
  monitorDockRect: { x: number; y: number; w: number; h: number } | null;
  setMonitorDockRect: (r: { x: number; y: number; w: number; h: number } | null) => void;

  // Workspaces: one split layout of windows each, plus the live terminals they
  // can show.
  terminals: TerminalInfo[];
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  /** Pending message to hand a chat's composer (set by editor comments / design notes). */
  composerInbox: ComposerInbox | null;

  /**
   * The Hypergate daemon on this machine: `undefined` while we're still
   * probing, `null` when nothing is listening.
   *
   * Kept in the store rather than in Settings' local state because the pairing
   * is app-wide: the sidebar offers the tab, the command palette connects, and
   * an `nekko-agent://` deep link can arrive with no view mounted at all.
   */
  hypergate: HypergateInfo | null | undefined;
  /** Re-probe for the daemon. Cheap and side-effect free; safe to call on a timer. */
  refreshHypergate: (port?: number) => Promise<void>;
  /**
   * Connect this install to Hypergate and open its tab: one path for the
   * Settings button, the command palette, and the deep link Hypergate itself
   * fires. Resolves false when no daemon answered.
   */
  connectHypergate: (port?: number) => Promise<boolean>;

  /** Live PR state per chat (PRs referenced in its transcript), for cards + badges. */
  prsBySession: Record<string, PrInfo[]>;
  /** Fetch a chat's PRs (gh/API, host-cached) and stash them for cards + badges. */
  refreshSessionPrs: (sessionId: string) => Promise<void>;
  /** Open a PR's diff as a window in the active workspace. */
  openPrPane: (url: string) => void;

  /** Marketplace installs (all targets), plus the runnable skills: Nekko Agent installs and imported ones. */
  installedSkills: InstalledSkillRecord[];
  installedSkillDefs: SkillDef[];
  /** Agent Skills found in other tools' folders (Claude Code, Codex, Gemini CLI, .agents); also merged into installedSkillDefs. */
  externalSkillDefs: SkillDef[];
  refreshSkills: () => Promise<void>;

  /** The skill armed in each chat's composer (highlighted pill, runs on send). */
  activeSkillBySession: Record<string, SkillDef | null>;
  setActiveSkill: (sessionId: string, skill: SkillDef | null) => void;

  /**
   * What's typed but unsent in each chat's composer. The pane owns the text;
   * this mirror exists so the Context Inspector on the right can count the
   * draft's tokens while you type (the host's context bundle only knows about
   * sent messages).
   */
  draftBySession: Record<string, string>;
  setSessionDraft: (sessionId: string, text: string) => void;

  setActiveProject: (id: string | null) => void;
  pushToast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  newChat: () => Promise<void>;
  /** A new Image chat on this image model, starting from its family's tuned steps and CFG. */
  newImageChat: (modelId: string, defaults?: { steps: number; cfgScale: number }) => Promise<void>;
  setMascotMood: (m: MascotMood) => void;
  setView: (v: View) => void;
  setOnboardingOpen: (open: boolean) => void;
  refreshSettings: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setActiveSession: (id: string | null) => void;
  refreshProviders: () => Promise<void>;
  selectProvider: (id: string) => Promise<void>;
  /** Re-list a provider's models after a background catalog refresh. */
  reloadModels: (providerId: string) => Promise<void>;
  selectModel: (id: string) => void;
  toggleContextPanel: () => void;
  togglePlanRail: () => void;
  applyTheme: () => void;

  refreshTerminals: () => Promise<void>;
  newTerminal: (workspaceId?: string, shell?: string) => Promise<void>;
  newTerminalWorkspace: (workspaceId?: string, shell?: string) => Promise<void>;
  openChatPane: (sessionId: string) => void;
  openTerminalPane: (terminalId: string) => void;
  openFilePane: (path: string) => void;
  openBrowserPane: (url?: string) => void;
  /** Open (or focus) the Hypergate manager as a tab in this window. */
  openHypergatePane: () => void;
  /** Route text to a chat's composer, Add to prompt (run=false) or Run now (run=true). */
  sendToChat: (text: string, run: boolean) => Promise<void>;
  /**
   * Arm a skill as the usage chip in the active chat's composer (opening or
   * creating a chat first), exactly as picking it from the `/` menu does. The
   * draft is left alone. A goal skill has no chip, so it goes through
   * `sendToChat` as `/goal ` text like before.
   */
  attachSkillToChat: (skill: SkillDef) => Promise<void>;
  /** Open the diff/approve review for a session's changed files. */
  openDiffPane: (sessionId: string) => void;
  /**
   * Give a chat a companion window (Changes, Browser or Files) in its own
   * workspace, where the Command Center shows it under the chat's window.
   * Unlike the open*Pane actions this stays on the current view. Returns false
   * when the chat's workspace has no room left to split.
   */
  openCompanion: (sessionId: string, kind: 'diff' | 'browser' | 'files') => boolean;

  /** Switch to a workspace (and to the chat it is about). */
  setActiveWorkspace: (id: string) => void;
  /** Close a whole workspace and every window in it. */
  closeWorkspace: (id: string) => void;
  /**
   * Archive the chat a workspace is about and close the workspace. The chat
   * keeps its transcript and can be read or restored from the Archived list
   * until the retention window runs out. A terminal workspace just closes.
   */
  archiveWorkspace: (id: string) => Promise<void>;
  /** Archive one chat by id (and close any workspace showing it). */
  archiveChat: (sessionId: string) => Promise<void>;
  /** Bring an archived chat back to the workspace list and open it. */
  restoreChat: (sessionId: string) => Promise<void>;
  /** Delete an archived chat for good. */
  deleteChatForever: (sessionId: string) => Promise<void>;
  /** Whether the sidebar shows the Archived list instead of the workspaces. */
  archiveOpen: boolean;
  setArchiveOpen: (open: boolean) => void;
  /** The archived chat being read, shown read-only in place of the workspaces. */
  archivedViewId: string | null;
  setArchivedView: (sessionId: string | null) => void;
  /**
   * Text and images to drop into a chat's composer when it next mounts (Copy
   * to composer, Split to a new chat). Consumed once by that chat's pane.
   */
  composerSeed: { sessionId: string; text: string; images: string[] } | null;
  seedComposer: (sessionId: string, text: string, images: string[]) => void;
  /**
   * Start a new chat holding this chat's conversation up to (not including)
   * `beforeMessageId`, with that message's text and images waiting in its
   * composer. "Split here" from a message.
   */
  splitChat: (sessionId: string, beforeMessageId: string) => Promise<void>;
  /** Put a new window on one side of an existing one. */
  splitPane: (paneId: string, dir: Direction, kind: PaneKind, refId?: string) => void;
  /** Start a chat and put it beside an existing window, in the same workspace. */
  newChatInPane: (paneId: string, dir: Direction) => Promise<void>;
  /** Start a terminal and put it beside an existing window, in the same workspace. */
  newTerminalInPane: (paneId: string, dir: Direction) => Promise<void>;
  /** Point an open window at something else (an explorer at another folder). */
  retargetPane: (paneId: string, refId: string) => void;
  /** Drag a window onto a side of another one, anywhere in the same workspace. */
  movePane: (paneId: string, targetPaneId: string, dir: Direction) => void;
  /** Trade two windows' places, leaving the workspace's shape alone. */
  swapPanes: (paneId: string, targetPaneId: string) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  /** Drag the divider at `index` inside a split (fraction of the split, from its start). */
  resizePanes: (splitId: string, index: number, fraction: number) => void;
  /** Whether `paneId` can still grow that way inside the 8×8 ceiling. */
  canSplitPane: (paneId: string, dir: Direction) => boolean;

  // Sidebar drag-and-drop: persist project order and per-project item order.
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;
  layoutChats: (targetWorkspaceId: string | undefined, orderedIds: string[], moveId: string | null) => Promise<void>;
  layoutTerminals: (targetWorkspaceId: string | undefined, orderedIds: string[], moveId: string | null) => Promise<void>;
}

/** Where a window already showing this thing lives, across every workspace. */
function locatePane(
  workspaces: Workspace[],
  kind: PaneKind,
  refId: string,
): { workspaceId: string; paneId: string } | null {
  for (const w of workspaces) {
    const p = findPaneByRef(w.root, kind, refId);
    if (p) return { workspaceId: w.id, paneId: p.id };
  }
  return null;
}

/**
 * Bring an already-open window to the front of its workspace. Focusing a chat
 * also makes it the session the rest of the app reports on, so the context
 * panel and the sidebar card follow what you just clicked.
 */
function focusPane(s: UiState, workspaceId: string, paneId: string): Partial<UiState> {
  const workspace = s.workspaces.find((w) => w.id === workspaceId);
  const pane = findPane(workspace?.root ?? null, paneId);
  return {
    view: 'chat' as View,
    activeWorkspaceId: workspaceId,
    // Returning to the workspace's selected pane changes visibility, not layout.
    workspaces: workspace?.activePaneId === paneId ? s.workspaces
      : s.workspaces.map((w) => (w.id === workspaceId ? { ...w, activePaneId: paneId } : w)),
    activeSessionId: pane?.kind === 'chat' ? pane.refId : s.activeSessionId,
  };
}

/**
 * Open a window in the workspace you are looking at, beside the one you are
 * looking at — the same place a tab used to appear, except the chat stays on
 * screen next to it. With no workspace open yet the window becomes one of its
 * own, so an action from the Command Center or a deep link always lands
 * somewhere.
 */
function openInActive(s: UiState, pane: WbPane): Partial<UiState> {
  const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];
  if (!active?.root) return addWorkspace(s, pane);
  // Beside the focused window when that is a chat, otherwise beside the chat
  // the workspace is about: a file opened out of a run shouldn't land inside
  // whatever browser you last clicked on.
  const target =
    active.activePaneId ??
    findPaneByRef(active.root, active.anchor.kind, active.anchor.refId)?.id ??
    null;
  if (!target) return {};
  const dir: Direction = canSplit(active.root, target, 'right') ? 'right' : 'down';
  return {
    view: 'chat' as View,
    activeWorkspaceId: active.id,
    workspaces: s.workspaces.map((w) =>
      w.id === active.id
        ? { ...w, root: splitInTree(w.root, target, dir, pane), activePaneId: pane.id }
        : w,
    ),
  };
}

/**
 * The project folder the workspace holding this window is about, read off its
 * anchor. Used so work added inside a workspace inherits its project instead of
 * whichever one happens to be selected globally.
 */
function projectOfPane(s: UiState, paneId: string): string | undefined {
  const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
  if (!ws) return undefined;
  if (ws.anchor.kind === 'chat') return s.sessions.find((x) => x.id === ws.anchor.refId)?.workspaceId;
  if (ws.anchor.kind === 'terminal') return s.terminals.find((t) => t.id === ws.anchor.refId)?.workspaceId;
  return undefined;
}

/**
 * The chat a pane works for: the pane itself when it is a chat, otherwise the
 * chat its workspace was started from. A terminal opened beside a chat should
 * land in that chat's own worktree rather than the shared project checkout.
 */
function chatOfPane(s: UiState, paneId: string): string | undefined {
  const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
  if (!ws) return undefined;
  const pane = allPanes(ws.root).find((p) => p.id === paneId);
  if (pane?.kind === 'chat') return pane.refId;
  return ws.anchor.kind === 'chat' ? ws.anchor.refId : undefined;
}

/** Start a new workspace around one window and switch to it. */
function addWorkspace(s: UiState, pane: WbPane): Partial<UiState> {
  const created: Workspace = {
    id: newWorkspaceId(),
    anchor: { kind: pane.kind, refId: pane.refId },
    root: pane,
    activePaneId: pane.id,
  };
  return {
    view: 'chat' as View,
    workspaces: [...s.workspaces, created],
    activeWorkspaceId: created.id,
    activeSessionId: pane.kind === 'chat' ? pane.refId : s.activeSessionId,
  };
}

/** Rewrite one workspace's tree, dropping it entirely once it holds nothing. */
function updateWorkspace(s: UiState, id: string, fn: (w: Workspace) => Workspace): Partial<UiState> {
  let changed = false;
  const mapped = s.workspaces.map((w) => {
    if (w.id !== id) return w;
    const next = fn(w);
    if (next !== w) changed = true;
    return next;
  });
  // Nothing moved: keep the same array so every wall window subscribed to
  // `workspaces` does not re-render (and re-measure) for a no-op.
  if (!changed) return {};
  const workspaces = mapped.filter((w) => w.root !== null);
  return {
    workspaces,
    activeWorkspaceId: workspaces.some((w) => w.id === s.activeWorkspaceId)
      ? s.activeWorkspaceId
      : workspaces[workspaces.length - 1]?.id ?? null,
  };
}

function defaultChatFolder(state: UiState): string | undefined {
  // A saved default folder wins; supporting defaults are applied where a new
  // agent is configured (the wall), this path takes only the primary.
  const saved = state.settings?.defaultWorkspaceIds?.find((d) => state.settings?.workspaces.some((w) => w.id === d));
  if (saved) return saved;
  const id = state.activeProjectId;
  return id && (!state.settingsLoaded || state.settings?.workspaces.some((w) => w.id === id)) ? id : undefined;
}

/** Target the active chat, creating one if there isn't a usable session, and show it. */
async function openUsableChat(get: () => UiState, set: (p: Partial<UiState>) => void): Promise<string> {
  let sid = get().activeSessionId;
  if (!sid || !get().sessions.some((s) => s.id === sid)) {
    const s = await window.nekko.createSession(defaultChatFolder(get()));
    await get().refreshSessions();
    sid = s.id;
    set({ activeSessionId: sid });
  }
  set({ view: 'chat' });
  get().openChatPane(sid);
  return sid;
}

export const useStore = create<UiState>((set, get) => ({
  settings: null,
  view: 'command',
  sessions: [],
  sessionCtxEstimate: {},
  setSessionCtxEstimate: (sessionId, tokens) => set((state) => {
    if (tokens == null) {
      if (!(sessionId in state.sessionCtxEstimate)) return state;
      const next = { ...state.sessionCtxEstimate };
      delete next[sessionId];
      return { sessionCtxEstimate: next };
    }
    return state.sessionCtxEstimate[sessionId] === tokens
      ? state
      : { sessionCtxEstimate: { ...state.sessionCtxEstimate, [sessionId]: tokens } };
  }),
  activeSessionId: null,
  providers: [],
  models: [],
  activeProviderId: null,
  activeModelId: null,
  // Default the context panel closed on small screens (phones).
  contextPanelOpen: typeof window !== 'undefined' ? window.innerWidth >= 1024 : true,
  planRailOpen: readPlanRailOpen(),
  onboardingOpen: false,
  settingsLoaded: false,
  mascotMood: 'waving',
  toasts: [],
  paletteOpen: false,
  activeProjectId: readLastFolder(),
  terminals: [],
  workspaces: restored.workspaces,
  activeWorkspaceId: restored.activeWorkspaceId,
  prsBySession: {},
  composerInbox: null,
  archiveOpen: false,
  archivedViewId: null,
  composerSeed: null,

  setActiveProject: (id) => {
    try { localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify(id)); } catch { /* private mode */ }
    set({ activeProjectId: id });
  },
  pushToast: (kind, message) => {
    const id = `t_${Date.now().toString(36)}_${Math.floor(performance.now())}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  monitorDockRect: null,
  setMonitorDockRect: (r) =>
    set((s) => {
      const p = s.monitorDockRect;
      // The dock reports on every resize; skip no-op writes so the chip's warp
      // transform isn't recomputed for nothing.
      if (p === r || (p && r && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h)) return s;
      return { monitorDockRect: r };
    }),
  newChat: async () => {
    await get().refreshProviders();
    if (needsProviderSetup(get().providers, get().activeModelId ?? get().models[0]?.id)) {
      get().setView('models');
      return;
    }
    const s = await window.nekko.createSession(defaultChatFolder(get()));
    // The host already returned the full record: seed before opening the pane
    // so its first frame has the session and brain, without a round-trip.
    putCachedSession(s);
    set((state) => ({ sessions: [summarizeSession(s), ...state.sessions], activeSessionId: s.id, view: 'chat' }));
    get().openChatPane(s.id);
  },
  newImageChat: async (modelId, defaults) => {
    const created = await window.nekko.createSession(defaultChatFolder(get()));
    const s = (await window.nekko.setSessionOptions(created.id, {
      chatType: 'image',
      imageParams: { ...DEFAULT_IMAGE_CHAT_PARAMS, modelId, ...(defaults ?? {}) },
    })) ?? created;
    putCachedSession(s);
    set((state) => ({ sessions: [summarizeSession(s), ...state.sessions], activeSessionId: s.id, view: 'chat' }));
    get().openChatPane(s.id);
  },
  setMascotMood: (m) => set({ mascotMood: m }),
  // A destination that's been hidden can't be navigated to: land on the
  // Command Center instead of a dead end.
  setView: (v) => set((s) => ({ view: viewEnabled(v, s.settings) ? v : 'command' })),
  setOnboardingOpen: (open) => set({ onboardingOpen: open }),

  refreshSettings: async () => {
    try {
      const settings = await window.nekko.getSettings();
      const onboardingOpen = shouldAutoOpenOnboarding(settings);
      set({ settings, onboardingOpen, settingsLoaded: true });
      get().applyTheme();
      if (!get().activeProviderId && settings.defaultProviderId) {
        set({ activeProviderId: settings.defaultProviderId, activeModelId: settings.defaultModelId ?? null });
      }
      // Refreshing the folder list never chooses a folder for the user.
    } catch {
      // Never leave the app on the loading gate: if settings can't be read,
      // unblock the UI and let surfaces fall back to their empty states.
      set({ settingsLoaded: true });
    }
  },

  refreshSessions: async () => {
    const sessions = await window.nekko.listSessionSummaries();
    set({ sessions });
    // A restored layout can point at chats that were archived or deleted since
    // (another client, the retention purge). Drop those windows now that the
    // truth is known; terminals are pruned in refreshTerminals.
    const live = new Set(sessions.filter((x) => !x.archivedAt).map((x) => x.id));
    set((s) => {
      const workspaces = pruneLayout(s.workspaces, live, null, removePane);
      if (workspaces.length === s.workspaces.length && workspaces.every((w, i) => w === s.workspaces[i])) return s;
      return {
        workspaces,
        activeWorkspaceId: workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : workspaces[workspaces.length - 1]?.id ?? null,
      };
    });
    // The default chat to report on is the newest live one: an archived chat
    // is read from the Archived list, never opened as a workspace by default.
    const firstLive = sessions.find((x) => !x.archivedAt);
    const current = get().activeSessionId;
    if ((!current || !live.has(current)) && firstLive && !get().archivedViewId) set({ activeSessionId: firstLive.id });
  },

  installedSkills: [],
  installedSkillDefs: [],
  externalSkillDefs: [],
  refreshSkills: async () => {
    // Fetched independently: an older host without one of the channels keeps
    // whatever the other one returns, and a failure keeps the previous list.
    const [installed, external] = await Promise.allSettled([
      window.nekko.listInstalledSkills(),
      window.nekko.listExternalSkills(),
    ]);
    const installedSkills = installed.status === 'fulfilled' ? installed.value : get().installedSkills;
    const externalSkillDefs = external.status === 'fulfilled' ? external.value : get().externalSkillDefs;
    const marketDefs = installedSkills
      .filter((r) => normalizeInstallTarget(r.target) === 'nekko-agent')
      // Vaizer (non-catalog) installs carry their own snapshot on the record.
      .map((r) => r.skill ?? getMarketSkill(r.skillId))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map(marketToSkillDef);
    set({ installedSkills, externalSkillDefs, installedSkillDefs: [...marketDefs, ...externalSkillDefs] });
  },

  activeSkillBySession: {},
  setActiveSkill: (sessionId, skill) =>
    set((s) => ({ activeSkillBySession: { ...s.activeSkillBySession, [sessionId]: skill } })),

  draftBySession: {},
  setSessionDraft: (sessionId, text) =>
    set((s) => (s.draftBySession[sessionId] === text
      ? s
      : { draftBySession: { ...s.draftBySession, [sessionId]: text } })),
  setActiveSession: (id) => set({ activeSessionId: id }),

  refreshProviders: async () => {
    const providers = await window.nekko.listProviders();
    set({ providers });
    const active = get().activeProviderId ?? providers[0]?.id ?? null;
    if (active) {
      set({ activeProviderId: active });
      // Always populate models for the active provider on startup, guards a
      // race where a saved default provider is already active and would
      // otherwise never have its model list fetched.
      if (get().models.length === 0) await get().selectProvider(active);
    }
  },

  selectProvider: async (id) => {
    set({ activeProviderId: id, models: [] });
    const models = await window.nekko.listModels(id);
    // A slower catalog request must not overwrite a newer provider choice.
    if (get().activeProviderId !== id) return;
    set({ models });
    // Keep the current model if this provider serves it, otherwise leave it
    // unset: a chat then asks which model to use instead of inheriting a guess.
    // Picking the provider's first model (as this used to) is worse than asking,
    // because a local server lists more than chat models - LM Studio's first
    // entry is often `whisper-large-v3`, which can't answer a chat turn at all.
    if (!models.some((m) => m.id === get().activeModelId)) set({ activeModelId: null });
    // Loading or browsing a provider is not a model choice. Persist the pair
    // only in selectModel, otherwise the old default model can be associated
    // with an unrelated provider (including during startup).
  },

  reloadModels: async (providerId) => {
    if (get().activeProviderId !== providerId) return;
    const models = await window.nekko.listModels(providerId);
    set({ models });
    // Same rule as selectProvider: a model the refreshed catalog dropped is
    // unset rather than left pointing at an id that will 400.
    if (!models.some((m) => m.id === get().activeModelId)) set({ activeModelId: null });
  },

  selectModel: (id) => {
    set({ activeModelId: id });
    const defaultProviderId = get().activeProviderId;
    if (!defaultProviderId) return;
    void window.nekko.updateSettings({ defaultProviderId, defaultModelId: id })
      .then((settings) => set({ settings }))
      .catch((e) => get().pushToast('error', String(e)));
  },

  toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),

  togglePlanRail: () =>
    set((s) => {
      const planRailOpen = !s.planRailOpen;
      try { localStorage.setItem(PLAN_RAIL_KEY, planRailOpen ? '1' : '0'); } catch { /* private mode */ }
      return { planRailOpen };
    }),

  applyTheme: () => {
    const settings = get().settings;
    const theme = settings?.theme ?? 'system';
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);

    const presetId = settings?.themePreset;
    if (presetId) root.setAttribute('data-preset', presetId);
    else root.removeAttribute('data-preset');
    const preset = presetId ? THEME_PRESETS.find((p) => p.id === presetId) : undefined;

    const accent = currentPresetAccent(presetId, settings?.accent);
    const accent2 = currentPresetAccent(presetId, settings?.accent2);
    if (accent) root.style.setProperty('--accent', accent);
    else if (preset) root.style.setProperty('--accent', preset.accent);
    else root.style.removeProperty('--accent');

    if (accent2) root.style.setProperty('--accent-2', accent2);
    else if (preset?.accent2) root.style.setProperty('--accent-2', preset.accent2);
    else root.style.removeProperty('--accent-2');

    // The native window buttons sit in our title bar, so they have to follow
    // the theme with everything else.
    syncTitleBarOverlay();
  },

  refreshTerminals: async () => {
    try {
      const terminals = await window.nekko.listTerminals();
      set({ terminals });
      // Shells do not outlive the app's backend, so a restored terminal window
      // usually points at nothing; drop it instead of showing a dead pane.
      const ids = new Set(terminals.map((t) => t.id));
      set((s) => {
        // Chats are judged in refreshSessions; here only terminals are, so
        // every chat the layout mentions counts as alive.
        const keep = new Set(s.workspaces.flatMap((w) => [w.anchor.refId, ...allPanes(w.root).map((p) => p.refId)]));
        const workspaces = pruneLayout(s.workspaces, keep, ids, removePane);
        if (workspaces.length === s.workspaces.length && workspaces.every((w, i) => w === s.workspaces[i])) return s;
        return {
          workspaces,
          activeWorkspaceId: workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : workspaces[workspaces.length - 1]?.id ?? null,
        };
      });
    } catch {
      /* terminals unsupported on this transport */
    }
  },

  newTerminalWorkspace: async (workspaceId, shell) => {
    const t = await window.nekko.createTerminal({ workspaceId: workspaceId ?? get().activeProjectId ?? undefined, shell });
    await get().refreshTerminals();
    set((s) => ({ ...addWorkspace(s, { id: newPaneId(), kind: 'terminal', refId: t.id }), view: 'chat' }));
  },

  newTerminal: async (workspaceId, shell) => {
    const wid = workspaceId ?? get().activeProjectId ?? undefined;
    const t = await window.nekko.createTerminal({ workspaceId: wid, shell });
    await get().refreshTerminals();
    set({ view: 'chat' });
    get().openTerminalPane(t.id);
  },

  // A chat is what a workspace is usually about, so opening one that has no
  // workspace yet starts a workspace rather than adding a window to whatever
  // was on screen.
  openChatPane: (sessionId) => {
    set((s) => {
      // An archived chat opens read-only in the Archived list instead of as a
      // workspace, so nothing can be sent into it by accident.
      if (s.sessions.find((x) => x.id === sessionId)?.archivedAt) {
        return { view: 'chat' as View, archiveOpen: true, archivedViewId: sessionId };
      }
      // An active chat leaves the completed-chat reader, if it was open.
      const leaveReader = { archiveOpen: false, archivedViewId: null };
      const hit = locatePane(s.workspaces, 'chat', sessionId);
      if (hit) return { ...focusPane(s, hit.workspaceId, hit.paneId), ...leaveReader };
      return { ...addWorkspace(s, { id: newPaneId(), kind: 'chat', refId: sessionId }), ...leaveReader };
    });
  },

  openTerminalPane: (terminalId) => {
    set((s) => {
      const hit = locatePane(s.workspaces, 'terminal', terminalId);
      if (hit) return focusPane(s, hit.workspaceId, hit.paneId);
      return openInActive(s, { id: newPaneId(), kind: 'terminal', refId: terminalId });
    });
  },

  openFilePane: (path) => {
    set((s) => {
      const hit = locatePane(s.workspaces, 'file', path);
      if (hit) return focusPane(s, hit.workspaceId, hit.paneId);
      return openInActive(s, { id: newPaneId(), kind: 'file', refId: path });
    });
  },

  openBrowserPane: (url) => {
    set((s) => {
      const ref = url || 'about:blank';
      const hit = locatePane(s.workspaces, 'browser', ref);
      if (hit) return focusPane(s, hit.workspaceId, hit.paneId);
      return openInActive(s, { id: newPaneId(), kind: 'browser', refId: ref });
    });
  },

  openHypergatePane: () => {
    set((s) => {
      const url = s.hypergate?.uiUrl ?? `http://localhost:${s.hypergate?.port ?? 7777}/`;
      // One manager, so one window: any existing Hypergate pane is *the* pane,
      // whatever URL it was opened with (the port can change between runs), and
      // it is re-pointed at the current one rather than duplicated.
      const hit = s.workspaces
        .flatMap((w) => allPanes(w.root).map((p) => ({ w, p })))
        .find((x) => x.p.kind === 'hypergate');
      if (hit) {
        return {
          ...focusPane(s, hit.w.id, hit.p.id),
          workspaces: s.workspaces.map((w) =>
            w.id === hit.w.id
              ? { ...w, activePaneId: hit.p.id, root: retargetInTree(w.root, hit.p.id, url) }
              : w,
          ),
        };
      }
      return openInActive(s, { id: newPaneId(), kind: 'hypergate', refId: url });
    });
  },

  hypergate: undefined,
  refreshHypergate: async (port) => {
    try {
      const found = await window.nekko.detectHypergate(port);
      // Probing is anonymous by design, so a re-probe of the same daemon must
      // not forget what connecting to it taught us (which agent we are).
      set((s) => ({
        hypergate: found && s.hypergate?.port === found.port ? { ...s.hypergate, ...found } : found,
      }));
    } catch {
      // An older host (or the web edition talking to one) has no such channel;
      // "no daemon" is the honest answer there, not an error worth showing.
      set({ hypergate: null });
    }
  },
  connectHypergate: async (port) => {
    try {
      const info = await window.nekko.connectHypergate(port);
      if (!info) {
        get().pushToast('error', `Hypergate isn't running on port ${port ?? 7777}. Start it, then connect again.`);
        set({ hypergate: null });
        return false;
      }
      set({ hypergate: info });
      // The entry now lives in settings; re-read so the MCP list on screen
      // shows it without a manual refresh.
      await get().refreshSettings();
      get().openHypergatePane();
      get().pushToast(
        'success',
        `Hypergate connected: ${info.servers} server${info.servers === 1 ? '' : 's'}, tools now in every chat.`,
      );
      return true;
    } catch (e) {
      get().pushToast('error', `Could not connect Hypergate: ${(e as Error).message}`);
      return false;
    }
  },

  sendToChat: async (text, run) => {
    const sid = await openUsableChat(get, set);
    set({ composerInbox: { sessionId: sid, text, run } });
  },

  attachSkillToChat: async (skill) => {
    if (skill.kind === 'goal') return get().sendToChat(skill.template, false);
    const sid = await openUsableChat(get, set);
    get().setActiveSkill(sid, skill);
  },

  refreshSessionPrs: async (sessionId) => {
    try {
      const prs = await window.nekko.listSessionPrs(sessionId);
      set((s) => ({ prsBySession: { ...s.prsBySession, [sessionId]: prs } }));
    } catch {
      /* older host without PR channels, or gh/API unavailable */
    }
  },

  openPrPane: (url) => {
    set((s) => {
      const hit = locatePane(s.workspaces, 'pr', url);
      if (hit) return focusPane(s, hit.workspaceId, hit.paneId);
      return openInActive(s, { id: newPaneId(), kind: 'pr', refId: url });
    });
  },

  openDiffPane: (sessionId) => {
    set((s) => {
      const hit = locatePane(s.workspaces, 'diff', sessionId);
      if (hit) return focusPane(s, hit.workspaceId, hit.paneId);
      return openInActive(s, { id: newPaneId(), kind: 'diff', refId: sessionId });
    });
  },

  openCompanion: (sessionId, kind) => {
    // A chat's own folder companion follows the chat's folder: opening Files
    // for a chat whose folder has since changed points the existing one there.
    if (kind === 'files') {
      const s = get();
      const hit = locatePane(s.workspaces, 'chat', sessionId);
      const ws = hit && s.workspaces.find((w) => w.id === hit.workspaceId);
      const existing = ws && allPanes(ws.root).find((p) => p.kind === 'files');
      const path = chatFolderPath(s, sessionId);
      if (existing && path && existing.refId !== path) get().retargetPane(existing.id, path);
    }
    let opened = false;
    set((s) => {
      // The chat's own workspace, made if the chat has none yet. Never the
      // active one, and never a change of view: the wall stays where it is.
      let workspaces = s.workspaces;
      let hit = locatePane(workspaces, 'chat', sessionId);
      if (!hit) {
        const created = addWorkspace(s, { id: newPaneId(), kind: 'chat', refId: sessionId });
        workspaces = created.workspaces ?? workspaces;
        hit = locatePane(workspaces, 'chat', sessionId);
      }
      const ws = hit && workspaces.find((w) => w.id === hit!.workspaceId);
      if (!hit || !ws?.root) return {};
      const refId = kind === 'diff' ? sessionId : kind === 'browser' ? 'about:blank' : chatFolderPath(s, sessionId);
      // One of each per chat: asking again just keeps the one already there.
      if (allPanes(ws.root).some((p) => p.kind === kind && (kind !== 'diff' || p.refId === sessionId))) {
        opened = true;
        return workspaces === s.workspaces ? {} : { workspaces };
      }
      const dir: Direction | null = canSplit(ws.root, hit.paneId, 'right') ? 'right' : canSplit(ws.root, hit.paneId, 'down') ? 'down' : null;
      if (!dir) return workspaces === s.workspaces ? {} : { workspaces };
      const pane: WbPane = { id: newPaneId(), kind, refId };
      opened = true;
      return { workspaces: workspaces.map((w) => (w.id === ws.id ? { ...w, root: splitInTree(w.root, hit!.paneId, dir, pane) } : w)) };
    });
    return opened;
  },

  setActiveWorkspace: (id) => {
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === id);
      if (!ws) return {};
      // Report on the chat you'd be looking at, which is the focused window when
      // that's a chat and the workspace's own chat otherwise.
      const focused = findPane(ws.root, ws.activePaneId ?? '');
      const chat = focused?.kind === 'chat' ? focused : allPanes(ws.root).find((p) => p.kind === 'chat');
      return {
        view: 'chat' as View,
        activeWorkspaceId: id,
        activeSessionId: chat?.refId ?? s.activeSessionId,
        archiveOpen: false,
        archivedViewId: null,
      };
    });
  },

  closeWorkspace: (id) => {
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      return {
        workspaces,
        activeWorkspaceId:
          s.activeWorkspaceId === id ? workspaces[workspaces.length - 1]?.id ?? null : s.activeWorkspaceId,
      };
    });
  },

  archiveChat: async (sessionId) => {
    try {
      // Stop a run first: an archived chat is read-only, and a turn still
      // writing to it would contradict that.
      await window.nekko.abortChat(sessionId);
    } catch { /* nothing running */ }
    try {
      const saved = await window.nekko.setSessionOptions(sessionId, { archivedAt: Date.now() });
      if (!saved || !isArchived(saved)) throw new Error('The engine did not save completion. Restart with an updated engine and try again.');
      // Only close the workspace once the engine confirms completion was saved.
      set((s) => {
        const workspaces = s.workspaces
          .filter((w) => !(w.anchor.kind === 'chat' && w.anchor.refId === sessionId))
          .map((w) => {
            const pane = findPaneByRef(w.root, 'chat', sessionId);
            return pane ? { ...w, root: removePane(w.root, pane.id), activePaneId: w.activePaneId === pane.id ? null : w.activePaneId } : w;
          })
          .filter((w) => w.root !== null)
          .map((w) => ({ ...w, activePaneId: w.activePaneId ?? allPanes(w.root)[0]?.id ?? null }));
        return {
          workspaces,
          activeWorkspaceId: workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : workspaces[workspaces.length - 1]?.id ?? null,
          activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
        };
      });
      get().pushToast('success', 'Chat completed. Find it under Completed for 60 days.');
    } catch (e) {
      get().pushToast('error', `Could not complete the chat: ${(e as Error).message}`);
    }
    await get().refreshSessions();
  },

  archiveWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (ws.anchor.kind !== 'chat') return get().closeWorkspace(id);
    await get().archiveChat(ws.anchor.refId);
    // archiveChat closes the whole anchored workspace only after saving.
  },

  restoreChat: async (sessionId) => {
    try {
      await window.nekko.setSessionOptions(sessionId, { archivedAt: null });
    } catch (e) {
      get().pushToast('error', `Could not restore the chat: ${(e as Error).message}`);
      return;
    }
    await get().refreshSessions();
    set({ archivedViewId: null, archiveOpen: false });
    get().openChatPane(sessionId);
  },

  deleteChatForever: async (sessionId) => {
    try {
      await window.nekko.abortChat(sessionId);
    } catch { /* nothing running */ }
    try {
      await window.nekko.deleteSession(sessionId);
    } catch (e) {
      get().pushToast('error', `Could not delete the chat: ${(e as Error).message}`);
      return;
    }
    // Remove open views only after the host confirms permanent deletion.
    for (const ws of get().workspaces) {
      if (ws.anchor.kind === 'chat' && ws.anchor.refId === sessionId) {
        get().closeWorkspace(ws.id);
      } else {
        for (const pane of allPanes(ws.root)) {
          if (pane.kind === 'chat' && pane.refId === sessionId) get().closePane(pane.id);
        }
      }
    }
    set((s) => ({
      ...(s.archivedViewId === sessionId ? { archivedViewId: null, archiveOpen: false } : {}),
      ...(s.activeSessionId === sessionId ? { activeSessionId: null } : {}),
    }));
    await get().refreshSessions();
  },

  setArchiveOpen: (open) => set({ archiveOpen: open, ...(open ? {} : { archivedViewId: null }) }),
  setArchivedView: (sessionId) => set({ archivedViewId: sessionId, view: 'chat' }),

  seedComposer: (sessionId, text, images) => set({ composerSeed: { sessionId, text, images } }),

  splitChat: async (sessionId, beforeMessageId) => {
    let source: Session | null = null;
    try { source = await window.nekko.getSession(sessionId); } catch { /* reported below */ }
    const msg = source?.messages.find((m) => m.id === beforeMessageId);
    const fork = await window.nekko.forkSession(sessionId, beforeMessageId).catch(() => null);
    if (!fork) {
      get().pushToast('error', 'Could not split this conversation.');
      return;
    }
    await get().refreshSessions();
    if (msg) get().seedComposer(fork.id, msg.skill ? msg.skill.input : msg.content, msg.images ?? []);
    get().openChatPane(fork.id);
  },

  splitPane: (paneId, dir, kind, refId) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      if (!ws || !canSplit(ws.root, paneId, dir)) return {};
      const pane: WbPane = { id: newPaneId(), kind, refId: refId ?? '' };
      return {
        ...updateWorkspace(s, ws.id, (w) => ({
          ...w,
          root: splitInTree(w.root, paneId, dir, pane),
          activePaneId: pane.id,
        })),
        activeWorkspaceId: ws.id,
        activeSessionId: kind === 'chat' ? pane.refId : s.activeSessionId,
      };
    });
  },

  // Creating a chat or a terminal has to reach the host first, so these can't
  // be folded into `splitPane`. The project comes from the workspace being
  // split rather than the global one: a second agent added to a project's
  // workspace belongs to that project.
  newChatInPane: async (paneId, dir) => {
    const project = projectOfPane(get(), paneId) ?? get().activeProjectId ?? undefined;
    const session = await window.nekko.createSession(project);
    await get().refreshSessions();
    get().splitPane(paneId, dir, 'chat', session.id);
  },

  newTerminalInPane: async (paneId, dir) => {
    const project = projectOfPane(get(), paneId) ?? get().activeProjectId ?? undefined;
    const term = await window.nekko.createTerminal({ workspaceId: project, sessionId: chatOfPane(get(), paneId) });
    await get().refreshTerminals();
    get().splitPane(paneId, dir, 'terminal', term.id);
  },

  retargetPane: (paneId, refId) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      if (!ws) return {};
      return updateWorkspace(s, ws.id, (w) => ({ ...w, root: retargetInTree(w.root, paneId, refId) }));
    });
  },

  movePane: (paneId, targetPaneId, dir) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      if (!ws) return {};
      return updateWorkspace(s, ws.id, (w) => ({ ...w, root: moveInTree(w.root, paneId, targetPaneId, dir) }));
    });
  },

  swapPanes: (paneId, targetPaneId) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      if (!ws) return {};
      return updateWorkspace(s, ws.id, (w) => ({ ...w, root: swapInTree(w.root, paneId, targetPaneId) }));
    });
  },

  closePane: (paneId) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      if (!ws) return {};
      return updateWorkspace(s, ws.id, (w) => {
        const root = removePane(w.root, paneId);
        return {
          ...w,
          root,
          activePaneId: w.activePaneId === paneId ? allPanes(root)[0]?.id ?? null : w.activePaneId,
        };
      });
    });
  },

  setActivePane: (paneId) => {
    set((s) => {
      const ws = s.workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
      return ws ? focusPane(s, ws.id, paneId) : {};
    });
  },

  resizePanes: (splitId, index, fraction) => {
    set((s) => {
      if (!s.activeWorkspaceId) return {};
      return updateWorkspace(s, s.activeWorkspaceId, (w) => ({
        ...w,
        root: resizeSplit(w.root, splitId, index, fraction),
      }));
    });
  },

  canSplitPane: (paneId, dir) => {
    const ws = get().workspaces.find((w) => allPanes(w.root).some((p) => p.id === paneId));
    return ws ? canSplit(ws.root, paneId, dir) : false;
  },

  reorderWorkspaces: async (orderedIds) => {
    const s = get().settings;
    if (!s) return;
    const byId = new Map(s.workspaces.map((w) => [w.id, w]));
    const workspaces = orderedIds.map((id) => byId.get(id)).filter((w): w is NonNullable<typeof w> => !!w);
    if (workspaces.length !== s.workspaces.length) return; // guard against a lost entry
    await window.nekko.updateSettings({ workspaces });
    await get().refreshSettings();
  },

  layoutChats: async (targetWorkspaceId, orderedIds, moveId) => {
    if (moveId) await window.nekko.setSessionWorkspace(moveId, targetWorkspaceId);
    await Promise.all(orderedIds.map((id, i) => window.nekko.setSessionOptions(id, { order: i })));
    await get().refreshSessions();
  },

  layoutTerminals: async (targetWorkspaceId, orderedIds, moveId) => {
    if (moveId) await window.nekko.updateTerminal(moveId, { workspaceId: targetWorkspaceId ?? null });
    await Promise.all(orderedIds.map((id, i) => window.nekko.updateTerminal(id, { order: i })));
    await get().refreshTerminals();
  },
}));

// Park the layout whenever it changes, trailing a beat so a divider drag (a
// write per pointer move) costs one write when it settles, plus once on the
// way out so the last change before a quit is never the one that is lost.
if (typeof window !== 'undefined') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    const s = useStore.getState();
    saveLayout({ workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId }, window.localStorage);
  };
  useStore.subscribe((s, prev) => {
    if (s.workspaces === prev.workspaces && s.activeWorkspaceId === prev.activeWorkspaceId) return;
    clearTimeout(timer);
    timer = setTimeout(persist, 300);
  });
  window.addEventListener?.('beforeunload', persist);
}
