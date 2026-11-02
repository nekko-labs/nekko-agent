import type { AgentEvent, CommandWallSetting, PendingInput, SessionSummary, TerminalInfo, WallLayout, MonitorsDock, MonitorKey } from '@nekko-agent/shared';
import { DEFAULT_WALL_LAYOUT, DEFAULT_MONITORS_DOCK, BLOCKED_META, isArchived, sessionLane } from '@nekko-agent/shared';
import {
  allPanes,
  canSplit,
  dockPane,
  extent,
  findPane,
  findPaneByRef,
  isSplit,
  MAX_ACROSS,
  newPaneId,
  newSplitId,
  removePane,
  reserveIdSeq,
  splitPane,
  swapPanes,
  type Direction,
  type PaneKind,
  type WbNode,
  type WbPane,
  type WbSplit,
} from './layout.js';

/**
 * The Agent board wall: which live windows are on it and how they are
 * split, plus the toolbar switches. Pure data and arithmetic, so the view can
 * be a thin layer and this can be tested on its own.
 *
 * The wall is the same split tree the Agent tab arranges its windows in
 * (`layout.ts`), so one layout engine serves both: dividers drag, every window
 * has a split compass, and a window is dragged onto any side of another. What
 * this module adds is the wall's own concerns: which chats and shells belong
 * on it, where a new window lands when nobody pointed at a side, how a set of
 * windows is tiled from scratch, and how the saved grid of the previous
 * design is carried over.
 */

/** Successful replies leave Dynamic's stage without changing the chat's lifecycle. */
export function minimizeFinishedReply(state: CommandWallState, event: AgentEvent, pending: Record<string, PendingInput>): CommandWallState {
  if (state.layout.mode === 'focus' || event.type !== 'done' || (event.stop && event.stop !== 'complete') || pending[event.sessionId]) return state;
  const panes = allPanes(state.root).filter((p) => p.kind === 'chat' && p.refId === event.sessionId);
  if (!panes.length) return state;
  // The agent leaves; its zone stays, empty.
  return { ...state, root: panes.reduce((root, pane) => clearZone(root, pane.id), state.root) };
}

export type WallFilter = 'all' | 'chat' | 'terminal';

/** Only chats and shells belong in the wall tree; dashboard monitors live in the Monitors dock. */
export type WallKind = 'chat' | 'terminal';
export const WALL_KINDS: readonly WallKind[] = ['chat', 'terminal'];

export type { WallLayout, WallLayoutMode, MonitorsDock, MonitorsSide, MonitorKey } from '@nekko-agent/shared';
export { DEFAULT_WALL_LAYOUT, DEFAULT_MONITORS_DOCK };
export const MONITORS: Array<{ key: MonitorKey; label: string; blurb: string }> = [
  { key: 'hardware', label: 'Hardware', blurb: 'Local resource monitors' },
  { key: 'localModels', label: 'Local models', blurb: 'Models loaded on this machine and where they run' },
  { key: 'utilization', label: 'Utilization', blurb: 'Tokens and model usage' },
  { key: 'budget', label: 'Budget', blurb: 'Monthly spend against your advisory budget' },
  { key: 'automations', label: 'Automations', blurb: 'Scheduled and running automations' },
  { key: 'insights', label: 'Insights', blurb: 'Usage trends and optimization tips' },
];

export type InsightPanel = 'vitals' | 'optimize' | 'cost' | 'tokens' | 'models' | 'replies' | 'services';

export const INSIGHT_PANELS: Array<{ key: InsightPanel; label: string; blurb: string }> = [
  { key: 'vitals', label: 'Vitals', blurb: 'Agents working, waiting on you, automations, terminals, tokens and spend' },
  { key: 'optimize', label: 'Optimize tips', blurb: 'Ways to cut token spend, from your own usage' },
  { key: 'cost', label: 'Cost', blurb: 'This month, the projection, daily spend and the top agents' },
  { key: 'tokens', label: 'Tokens over time', blurb: 'Input and output tokens, day by day' },
  { key: 'models', label: 'By model', blurb: 'Tokens and cost per model' },
  { key: 'replies', label: 'Replies', blurb: 'How replies end and how many tool steps they take' },
  { key: 'services', label: 'Services', blurb: 'Providers, MCP servers and the remote relay, with live status' },
];

export interface InsightsPrefs {
  panels: Record<InsightPanel, boolean>;
}

export type ComposerSide = 'top' | 'bottom';
export type ComposerAlign = 'left' | 'center' | 'right';
/**
 * Where the wall's one composer sits (above or below the windows, to the left,
 * centred, or to the right) and the size it was dragged to. Width and height
 * are kept with the rest of the wall so a resize survives leaving the page and
 * restarting the app; absent means the default size.
 */
export interface ComposerDock {
  side: ComposerSide;
  align: ComposerAlign;
  /** Dragged width in CSS pixels, clamped to the wall's width when drawn. */
  width?: number;
  /** Dragged height in CSS pixels, clamped to the space available when drawn. */
  height?: number;
}
export const DEFAULT_COMPOSER_DOCK: ComposerDock = { side: 'bottom', align: 'center' };

/**
 * The widest the composer can be: as wide as the wall's windows, edge to edge.
 * The composer row and the wall pad their content by different amounts (the
 * wall's padding includes a reserved scrollbar gutter), so the row's own width
 * is too wide by a few pixels; measure the windows' stage instead when it is
 * there. Falls back to the row's content box, then a guess.
 */
export function composerMaxWidth(panel: HTMLElement | null): number {
  const row = panel?.parentElement;
  const stage = panel?.closest('.wall-column')?.querySelector<HTMLElement>('.command-wall-stage');
  const stageWidth = stage?.getBoundingClientRect().width ?? 0;
  if (stageWidth > 0) return Math.floor(stageWidth);
  if (!row) return 1000;
  const style = getComputedStyle(row);
  return Math.floor(row.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0'));
}

export interface CommandWallState {
  layout: WallLayout;
  dock: MonitorsDock;
  hero: string | null;
  /** Companion visibility keyed by session ID; does not fold whole chats. */
  folded: Record<string, boolean>;
  /** The split tree of windows, or null for an empty wall. */
  root: WbNode | null;
  /** New chats (including spawned sub-agents) join the wall as they appear. */
  autoAdd: boolean;
  filter: WallFilter;
  insights: InsightsPrefs;
  /** Chats created after this moment are auto-added; 0 until the wall has been seeded once. */
  watermark: number;
  composer: ComposerDock;
  tabs?: 'top' | 'left' | 'hidden';
  /** The panel of agent cards beside (or above) the wall. */
  agentPanel?: AgentPanelPrefs;
  /** Snap to grid: windows stay evenly spaced, and dividers snap back to even spacing. */
  snap?: boolean;
  /** The board is laid out in zones (every leaf is one); false until a pre-zones wall is migrated. */
  zones?: boolean;
  /** The zone clicked last: where an agent picked in the panel goes. */
  activeZone?: string | null;
  /** The zones intro has been shown (or dismissed) once. */
  zonesIntro?: boolean;
}

export interface AgentPanelPrefs {
  show: boolean;
  orientation: 'vertical' | 'horizontal';
}
export const DEFAULT_AGENT_PANEL: AgentPanelPrefs = { show: true, orientation: 'vertical' };

export function readAgentPanel(raw: unknown): AgentPanelPrefs {
  const p = raw && typeof raw === 'object' ? (raw as Partial<AgentPanelPrefs>) : {};
  return { show: p.show !== false, orientation: p.orientation === 'horizontal' ? 'horizontal' : 'vertical' };
}

/** Below this width the wall stacks its windows one above the other: a phone, or a very narrow window. */
export const NARROW_WIDTH = 720;
/** A window on a stacked (phone-width) wall gets this much height. */
export const NARROW_ROW_H = 440;
/** The stage's shape when nothing has measured it yet: a typical landscape window. */
export const DEFAULT_ASPECT = 1.7;

export const DEFAULT_INSIGHTS: InsightsPrefs = {
  panels: { vitals: true, optimize: true, cost: true, tokens: false, models: false, replies: false, services: false },
};

export const DEFAULT_WALL_STATE: CommandWallState = {
  layout: DEFAULT_WALL_LAYOUT,
  dock: DEFAULT_MONITORS_DOCK,
  hero: null,
  folded: {},
  root: null,
  autoAdd: true,
  filter: 'all',
  insights: DEFAULT_INSIGHTS,
  watermark: 0,
  composer: DEFAULT_COMPOSER_DOCK,
  tabs: 'top',
  agentPanel: DEFAULT_AGENT_PANEL,
  snap: false,
  zones: false,
  activeZone: null,
  zonesIntro: false,
};

export const WALL_STATE_KEY = 'nekko.commandWall';
/** Where the grid that came before this wall kept itself; read once, to carry a wall over. */
export const LEGACY_GRID_KEY = 'nekko.commandGrid';

/** A window pointing at a chat or shell. */
export function wallPane(kind: PaneKind, refId: string = kind): WbPane {
  return { id: newPaneId(), kind, refId };
}

export function hasPane(root: WbNode | null, kind: PaneKind, refId: string = kind): boolean {
  return allPanes(root).some((p) => p.kind === kind && p.refId === refId);
}

/** The agent windows, in reading order: what the numbers on the strips count and what Ctrl+Tab walks. */
export function wallAgents(root: WbNode | null): WbPane[] {
  return allPanes(root).filter((p) => p.kind === 'chat');
}

/** The agent after (or before) `current` in reading order, wrapping; the first when nothing is current. */
export function nextAgent(root: WbNode | null, current: string | null, step: 1 | -1 = 1): string | null {
  const ids = wallAgents(root).map((p) => p.refId);
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(i + step + ids.length) % ids.length];
}

/** A saved size: a finite pixel count in a sane range, or nothing. */
function readSize(raw: unknown, min: number, max: number): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max ? Math.round(raw) : undefined;
}

export function readDock(raw: unknown): ComposerDock {
  const d = raw && typeof raw === 'object' ? (raw as Partial<ComposerDock>) : {};
  const width = readSize(d.width, 120, 20000);
  const height = readSize(d.height, 60, 20000);
  return {
    side: d.side === 'top' ? 'top' : 'bottom',
    align: d.align === 'left' || d.align === 'right' ? d.align : 'center',
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/**
 * The shape a fresh tiling picks for `count` windows in an area of `aspect`
 * (width over height): the column count whose cells come closest to a
 * comfortable window (a bit wider than tall) while leaving the fewest empty
 * places. Two windows sit side by side, four make a square, five fill three
 * by two, and so on.
 */
export function autoShape(count: number, aspect = DEFAULT_ASPECT): { cols: number; rows: number } {
  const n = Math.max(1, count);
  let best = { cols: 1, rows: n, score: Infinity };
  for (let cols = 1; cols <= Math.min(8, n); cols++) {
    const rows = Math.ceil(n / cols);
    if (rows > 8) continue;
    const cellAspect = (aspect * rows) / cols;
    const score = Math.abs(Math.log(cellAspect / 1.4)) + (0.35 * (cols * rows - n)) / n;
    if (score < best.score - 1e-9) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

/**
 * Tile `panes` into a balanced tree: a column of equal rows, each a row of
 * equal windows, in reading order. The last row holds whatever is left, so
 * five windows are a row of three over a row of two. This is what a fresh
 * wall starts from and what Auto-arrange returns to.
 */
export function tileTree(panes: WbPane[], aspect = DEFAULT_ASPECT): WbNode | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) return panes[0];
  const { cols } = autoShape(panes.length, aspect);
  const rows: WbNode[] = [];
  for (let i = 0; i < panes.length; i += cols) {
    const slice = panes.slice(i, i + cols);
    rows.push(slice.length === 1 ? slice[0] : { id: newSplitId(), dir: 'row', children: slice, sizes: slice.map(() => 1 / slice.length) });
  }
  if (rows.length === 1) return rows[0];
  return { id: newSplitId(), dir: 'col', children: rows, sizes: rows.map(() => 1 / rows.length) };
}

/**
 * The same tree with every split evened out: each child gets a share in
 * proportion to how many windows it holds along the split's axis, so every
 * window in a row is as wide as its neighbours and every row as tall as the
 * next. Structure is kept; only sizes change.
 */
export function evenTree(node: WbNode | null): WbNode | null {
  if (!node || !isSplit(node)) return node;
  const weights = node.children.map((c) => (node.dir === 'row' ? extent(c).across : extent(c).down));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: node.children.map((c) => evenTree(c)!), sizes: weights.map((w) => w / total) };
}

/** The tree's shape without its sizes: which windows sit where, in which splits. */
export function treeShape(node: WbNode | null): string {
  if (!node) return '';
  return isSplit(node) ? `${node.dir}(${node.children.map(treeShape).join(',')})` : node.id;
}

/** Where divider `index` of split `splitId` sits, as a share of that split, or null when there is no such divider. */
export function splitBoundary(node: WbNode | null, splitId: string, index: number): number | null {
  if (!node || !isSplit(node)) return null;
  if (node.id === splitId) return index >= 0 && index < node.sizes.length - 1 ? node.sizes.slice(0, index + 1).reduce((a, b) => a + b, 0) : null;
  for (const c of node.children) {
    const found = splitBoundary(c, splitId, index);
    if (found !== null) return found;
  }
  return null;
}

/** How close (as a share of its split) a dragged divider must come to even spacing to snap to it. */
export const SNAP_RANGE = 0.04;

/** A dragged divider's position, pulled onto `target` when it is within reach. */
export function snapFraction(value: number, target: number | null, range = SNAP_RANGE): number {
  return target !== null && Math.abs(value - target) <= range ? target : value;
}

/**
 * Keep a snapping wall even: turning snap on, or any change to which windows
 * are on the wall and where (add, move, remove), re-evens it. Dragging a
 * divider changes sizes only, so it is left alone; the divider snaps instead.
 */
export function applySnap(prev: CommandWallState, next: CommandWallState): CommandWallState {
  if (!next.snap || !next.root) return next;
  if (prev.snap && treeShape(prev.root) === treeShape(next.root)) return next;
  return { ...next, root: evenTree(next.root) };
}

export interface LeafRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where each window sits, as fractions of the whole stage. */
export function leafRects(root: WbNode | null): Map<string, LeafRect> {
  const out = new Map<string, LeafRect>();
  const walk = (node: WbNode, rect: LeafRect) => {
    if (!isSplit(node)) { out.set(node.id, rect); return; }
    let at = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i] ?? 0;
      walk(
        child,
        node.dir === 'row'
          ? { x: rect.x + rect.width * at, y: rect.y, width: rect.width * share, height: rect.height }
          : { x: rect.x, y: rect.y + rect.height * at, width: rect.width, height: rect.height * share },
      );
      at += share;
    });
  };
  if (root) walk(root, { x: 0, y: 0, width: 1, height: 1 });
  return out;
}

/**
 * Put a window on the wall when nobody said where: beside the biggest window
 * there is, along its longer side, so the wall fills in evenly rather than
 * slicing one corner thinner and thinner. Returns the tree unchanged when the
 * 8×8 ceiling leaves no room.
 */
export function addPane(root: WbNode | null, pane: WbPane, aspect = DEFAULT_ASPECT): WbNode {
  if (!root) return pane;
  const rects = leafRects(root);
  let bestId: string | null = null;
  let bestArea = -1;
  let bestRect: LeafRect | null = null;
  // Unpositioned agents append in reading order, never halve the last agent.
  // Explicit compass placement still uses splitPane at the call site.
  if (pane.kind === 'chat') {
    const panes = [...allPanes(root), pane];
    if (panes.length > 64) return root;
    return tileTree(panes, aspect)!;
  }
  for (const [id, r] of rects) {
    const area = r.width * r.height;
    if (area > bestArea + 1e-9) { bestArea = area; bestId = id; bestRect = r; }
  }
  if (!bestId || !bestRect) return root;
  const wide = bestRect.width * aspect >= bestRect.height;
  const order: Direction[] = wide ? ['right', 'down'] : ['down', 'right'];
  for (const dir of order) {
    if (canSplit(root, bestId, dir)) return splitPane(root, bestId, dir, pane);
  }
  return root;
}

/**
 * Open a chat or shell from the panel, the toolbar or anywhere else: one
 * already on the board is only shown, its zone becoming the active one, so
 * nothing on the board moves; any other goes into the active zone. A chat
 * becomes the hero. Returns the same state when nothing changed, so
 * reselecting a chat neither re-renders the wall nor saves it again.
 */
export function openWallPane(state: CommandWallState, kind: PaneKind, refId: string): CommandWallState {
  let { root, activeZone = null } = state;
  const zone = zoneOf(root, kind, refId) ?? targetZone(state);
  if (!zone) {
    const pane = { ...emptyZone(null), kind, refId };
    root = pane;
    activeZone = pane.id;
  } else {
    root = fillZone(root, zone, kind, refId);
    activeZone = zone;
  }
  const hero = kind === 'chat' || state.layout.mode === 'focus' ? refId : state.hero;
  const filter = state.filter === 'all' || state.filter === kind ? state.filter : 'all';
  return root === state.root && hero === state.hero && filter === state.filter && activeZone === state.activeZone ? state : { ...state, root, hero, filter, activeZone };
}

export function addPanes(root: WbNode | null, panes: WbPane[], aspect = DEFAULT_ASPECT): WbNode | null {
  return panes.reduce<WbNode | null>((tree, p) => addPane(tree, p, aspect), root);
}

/** The tree the filter lets through: windows of the other kind are lifted out. */
export function filterTree(root: WbNode | null, filter: WallFilter): WbNode | null {
  if (filter === 'all') return root;
  const drop = filter === 'chat' ? 'terminal' : 'chat';
  return allPanes(root)
    .filter((p) => p.kind === drop)
    .reduce<WbNode | null>((tree, p) => removePane(tree, p.id), root);
}

/** A chat the wall can show: a real conversation, not archived, not a task's or training run's. */
function wallChat(s: SessionSummary): boolean {
  return !isArchived(s) && !s.taskId && !s.trainingRunId;
}

/**
 * What a wall starts with, and what a wall from before zones becomes: two
 * zones side by side holding the two most recently active chats of `pool`
 * (an empty zone for each one missing). Everything else is minimized, which
 * only takes it off the board: no chat is completed.
 */
export function seedWall(state: CommandWallState, pool: SessionSummary[], now: number): CommandWallState {
  const ids = pool.filter((s) => wallChat(s) && !s.parentSessionId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, START_ZONES).map((s) => s.id);
  const root = startZones(ids);
  return { ...state, root, zones: true, activeZone: allPanes(root)[0].id, watermark: now };
}

/**
 * Keep the wall honest against what exists: a zone whose chat is gone or
 * archived (completing a chat takes it off the board) or whose terminal is
 * gone is emptied, never removed. New chats are not opened on the board by
 * themselves; they wait in the agents panel. Called once both lists have
 * loaded; returns the same object when nothing changed.
 */
export function reconcileWall(state: CommandWallState, sessions: SessionSummary[], terminals: TerminalInfo[], now: number): CommandWallState {
  const chatById = new Map(sessions.map((s) => [s.id, s]));
  if (!state.zones) {
    // A wall that was never seeded draws from every chat; one from before zones keeps the two newest it showed.
    const pool = state.watermark === 0 ? sessions : wallAgents(state.root).flatMap((p) => chatById.get(p.refId) ?? []);
    return seedWall(state, pool, now);
  }
  const termIds = new Set(terminals.map((t) => t.id));
  let root = state.root;
  for (const p of allPanes(state.root)) {
    const keep = p.kind === 'chat' ? !!chatById.get(p.refId) && wallChat(chatById.get(p.refId)!) : p.kind === 'terminal' ? termIds.has(p.refId) : true;
    if (!keep) root = clearZone(root, p.id);
  }
  return root === state.root ? state : { ...state, root };
}

/* ---------- zones ---------- */

/** How many zones a fresh board starts with, side by side. */
export const START_ZONES = 2;

/** The first "Zone N" not already on the board. */
export function nextZoneName(root: WbNode | null): string {
  const taken = new Set(allPanes(root).map((p) => p.zone));
  let n = 1;
  while (taken.has(`Zone ${n}`)) n++;
  return `Zone ${n}`;
}

/** How many zone colours there are; `--zone-tint-0` … `--zone-tint-5` in styles.css. */
export const ZONE_TINTS = 6;

/**
 * Each zone's colour, by pane id. A zone keeps the tint it was given; one
 * saved before zones had colours takes the first tint free, in reading order,
 * so the board reads the same on every render.
 */
export function zoneTints(root: WbNode | null): Map<string, number> {
  const panes = allPanes(root);
  const tints = new Map<string, number>();
  const taken = new Set<number>();
  for (const p of panes) if (p.tint !== undefined) { tints.set(p.id, p.tint); taken.add(p.tint); }
  for (const p of panes) {
    if (tints.has(p.id)) continue;
    const free = Array.from({ length: ZONE_TINTS }, (_, i) => i).find((i) => !taken.has(i)) ?? tints.size % ZONE_TINTS;
    tints.set(p.id, free);
    taken.add(free);
  }
  return tints;
}

/** The tint a new zone on `root` gets: the first one no zone is using. */
export function nextZoneTint(root: WbNode | null): number {
  const taken = new Set(zoneTints(root).values());
  return Array.from({ length: ZONE_TINTS }, (_, i) => i).find((i) => !taken.has(i)) ?? taken.size % ZONE_TINTS;
}

/** The colour of the zone showing each chat or shell, by its id; agents off the board are absent. */
export function agentZoneTints(root: WbNode | null): Map<string, number> {
  const tints = zoneTints(root);
  return new Map(allPanes(root).filter((p) => p.refId && p.kind !== 'zone').map((p) => [p.refId, tints.get(p.id)!]));
}

/** Give a zone a colour of its own, picked from its header's menu. */
export function setZoneTint(root: WbNode | null, paneId: string, tint: number): WbNode | null {
  return mapLeaf(root, paneId, (p) => (p.tint === tint ? p : { ...p, tint }));
}

/** A zone with nothing in it, named and coloured after the ones already on `root`. */
export function emptyZone(root: WbNode | null): WbPane {
  return { id: newPaneId(), kind: 'zone', refId: '', zone: nextZoneName(root), tint: nextZoneTint(root) };
}

/** Two zones side by side holding `chatIds` in order; empty where there are fewer. */
export function startZones(chatIds: string[]): WbSplit {
  const children: WbPane[] = Array.from({ length: START_ZONES }, (_, i) => ({ id: newPaneId(), kind: chatIds[i] ? 'chat' : 'zone', refId: chatIds[i] ?? '', zone: `Zone ${i + 1}`, tint: i }));
  return { id: newSplitId(), dir: 'row', children, sizes: children.map(() => 1 / START_ZONES) };
}

function mapLeaf(node: WbNode | null, id: string, fn: (p: WbPane) => WbPane): WbNode | null {
  if (!node) return null;
  if (!isSplit(node)) return node.id === id ? fn(node) : node;
  return { ...node, children: node.children.map((c) => mapLeaf(c, id, fn)!) };
}

/** Take the agent (or shell) out of a zone and leave the zone, empty, where it was. */
export function clearZone(root: WbNode | null, paneId: string): WbNode | null {
  return mapLeaf(root, paneId, (p) => ({ ...p, kind: 'zone', refId: '', zone: p.zone ?? nextZoneName(root) }));
}

/**
 * Put a chat or shell in a zone. One already on the board trades places with
 * whatever the zone held, so an agent is never on the board twice.
 */
export function fillZone(root: WbNode | null, zoneId: string, kind: PaneKind, refId: string): WbNode | null {
  if (!findPane(root, zoneId)) return root;
  const there = findPaneByRef(root, kind, refId);
  if (there) return there.id === zoneId ? root : swapPanes(root, there.id, zoneId);
  return mapLeaf(root, zoneId, (p) => ({ ...p, kind, refId }));
}

/** Where an agent opened without a place goes: the active zone, else the first empty one, else the first. */
export function targetZone(state: Pick<CommandWallState, 'root' | 'activeZone'>): string | null {
  const zones = allPanes(state.root);
  return (zones.find((p) => p.id === state.activeZone) ?? zones.find((p) => p.kind === 'zone') ?? zones[0])?.id ?? null;
}

/** The zone showing this chat or shell, if any. */
export const zoneOf = (root: WbNode | null, kind: PaneKind, refId: string): string | null => findPaneByRef(root, kind, refId)?.id ?? null;

/** Where a new zone goes: beside a zone along one side, fitting its row or column, or along a whole side of the board. */
export type ZoneSpot = { paneId: string; side: Direction } | { edge: Direction };

/**
 * Add an empty zone. Beside a zone it joins that zone's row (or column) and
 * the row is evened out; along an edge it spans the whole board that way.
 * The tree is unchanged when the 8×8 ceiling leaves no room.
 */
export function addZone(root: WbNode | null, spot: ZoneSpot): { root: WbNode | null; id: string | null } {
  const zone = emptyZone(root);
  if (!root) return { root: zone, id: zone.id };
  let next: WbNode;
  if ('edge' in spot) next = dockPane(root, zone, spot.edge);
  else if (findPane(root, spot.paneId)) next = evenAround(splitPane(root, spot.paneId, spot.side, zone), zone.id);
  else return { root, id: null };
  const { across, down } = extent(next);
  return across <= MAX_ACROSS && down <= MAX_ACROSS ? { root: next, id: zone.id } : { root, id: null };
}

/** Even out only the split that directly holds `id`, by how many zones each child spans. */
function evenAround(node: WbNode, id: string): WbNode {
  if (!isSplit(node)) return node;
  if (node.children.some((c) => !isSplit(c) && c.id === id)) {
    const weights = node.children.map((c) => (node.dir === 'row' ? extent(c).across : extent(c).down));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    return { ...node, sizes: weights.map((w) => w / total) };
  }
  return { ...node, children: node.children.map((c) => evenAround(c, id)) };
}

/* ---------- persistence ---------- */

/** The digits of an id minted by `layout.ts`, so a restored tree's ids are never minted again. */
function idSeq(id: string): number {
  const m = /^(?:pane|split)_([0-9a-z]+)$/.exec(id);
  return m ? parseInt(m[1], 36) || 0 : 0;
}

/** A saved node, checked field by field; anything malformed drops out (a split left with one child collapses into it). */
function sanitize(node: unknown, reserve: (id: string) => void, dock: MonitorsDock): WbNode | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Partial<WbPane> & Partial<WbSplit>;
  if (typeof n.id !== 'string') return null;
  if (Array.isArray(n.children)) {
    if (n.dir !== 'row' && n.dir !== 'col') return null;
    const children: WbNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const kept = sanitize(c, reserve, dock);
      if (!kept) return;
      children.push(kept);
      const s = Array.isArray(n.sizes) ? n.sizes[i] : undefined;
      sizes.push(typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    const sum = sizes.reduce((a, b) => a + b, 0);
    reserve(n.id);
    return { id: n.id, dir: n.dir, children, sizes: sizes.map((s) => s / sum) };
  }
  if (n.kind === 'automations' || n.kind === 'insights') {
    dock.monitors[n.kind] = true;
    return null;
  }
  const zone = {
    ...(typeof n.zone === 'string' && n.zone ? { zone: n.zone } : {}),
    ...(Number.isInteger(n.tint) && (n.tint as number) >= 0 && (n.tint as number) < ZONE_TINTS ? { tint: n.tint as number } : {}),
  };
  if (n.kind === 'zone') { reserve(n.id); return { id: n.id, kind: 'zone', refId: '', ...zone }; }
  if (!WALL_KINDS.includes(n.kind as WallKind) || typeof n.refId !== 'string') return null;
  reserve(n.id);
  return { id: n.id, kind: n.kind as PaneKind, refId: n.refId, ...zone };
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function sanitizeWallLayout(raw: unknown): WallLayout {
  const value = record(raw);
  const dimension = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n)
    ? Math.min(6, Math.max(1, Math.round(n))) : fallback;
  return {
    mode: value.mode === 'focus' ? 'focus' : 'grid',
    cols: dimension(value.cols, DEFAULT_WALL_LAYOUT.cols),
    rows: dimension(value.rows, DEFAULT_WALL_LAYOUT.rows),
    // Grid was a third layout mode until 2026-10-24; a wall saved in it opens as Dynamic with Fixed grid on.
    fixedGrid: value.fixedGrid === true || value.mode === 'fixed',
  };
}

/** How the wall is drawn: Focused, free-form Dynamic, or Dynamic with Fixed grid on (`fixed`). */
export type WallArrangement = 'focus' | 'grid' | 'fixed';
export const wallArrangement = (layout: WallLayout): WallArrangement => (layout.mode === 'grid' && layout.fixedGrid ? 'fixed' : layout.mode);

/** Keep saved entries once, then append missing monitors so none are lost on migration. */
export function normalizeMonitorOrder(raw: unknown): MonitorKey[] {
  const keys = MONITORS.map(p => p.key);
  const saved = Array.isArray(raw) ? raw.filter((key): key is MonitorKey => keys.includes(key)) : [];
  return [...new Set([...saved, ...keys])];
}

/** Move to a target's slot; hidden and minimized monitors remain in the full order. */
export function reorderMonitor(raw: unknown, key: MonitorKey, target: MonitorKey): MonitorKey[] {
  const order = normalizeMonitorOrder(raw);
  const from = order.indexOf(key);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  order.splice(from, 1);
  order.splice(to, 0, key);
  return order;
}

/**
 * Drop a monitor just before or after an anchor monitor (where a drag's landing
 * zone sat); hidden and minimized monitors keep their places in the full order.
 */
export function placeMonitor(raw: unknown, key: MonitorKey, anchor: MonitorKey, where: 'before' | 'after'): MonitorKey[] {
  const order = normalizeMonitorOrder(raw);
  if (key === anchor) return order;
  order.splice(order.indexOf(key), 1);
  order.splice(order.indexOf(anchor) + (where === 'after' ? 1 : 0), 0, key);
  return order;
}

export function sanitizeMonitorsDock(raw: unknown): MonitorsDock {
  const value = record(raw);
  // Monitors were "panels" until 2026-10; older settings keep those names.
  const enabled = record(value.monitors ?? value.panels);
  const out = { ...DEFAULT_MONITORS_DOCK.monitors };
  const minimized = { ...DEFAULT_MONITORS_DOCK.minimized };
  const savedMinimized = record(value.minimized);
  for (const key of Object.keys(out) as MonitorKey[]) {
    if (typeof enabled[key] === 'boolean') out[key] = enabled[key];
    if (typeof savedMinimized[key] === 'boolean') minimized[key] = savedMinimized[key];
  }
  return {
    side: value.side === 'left' || value.side === 'top' || value.side === 'bottom' ? value.side : 'right',
    show: typeof value.show === 'boolean' ? value.show : true,
    minimized,
    monitorOrder: normalizeMonitorOrder(value.monitorOrder ?? value.panelOrder),
    monitors: out,
  };
}

function readFolded(raw: unknown): Record<string, boolean> {
  return Object.fromEntries(Object.entries(record(raw)).filter((entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === 'boolean'));
}

function readWatermark(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function readPanels(raw: unknown): InsightsPrefs {
  const panels = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_INSIGHTS.panels };
  for (const key of Object.keys(out) as InsightPanel[]) if (typeof panels[key] === 'boolean') out[key] = panels[key] as boolean;
  return { panels: out };
}

/**
 * The grid this wall replaced kept a flat list of cells; the first run after
 * the change tiles them so nobody's wall starts over; its panels move to the Monitors dock.
 */
export function migrateGridState(saved: unknown): CommandWallState | null {
  if (!saved || typeof saved !== 'object') return null;
  const g = saved as { cells?: unknown; autoAdd?: unknown; filter?: unknown; insights?: { show?: unknown; panels?: unknown }; watermark?: unknown };
  const cells = Array.isArray(g.cells)
    ? g.cells.filter((c): c is { kind: 'chat' | 'terminal'; refId: string } => !!c && typeof c === 'object' && ((c as { kind?: unknown }).kind === 'chat' || (c as { kind?: unknown }).kind === 'terminal') && typeof (c as { refId?: unknown }).refId === 'string')
    : [];
  const root = tileTree(cells.map((c) => wallPane(c.kind, c.refId)));
  const dock = sanitizeMonitorsDock(undefined);
  dock.monitors.automations = g.insights?.show !== false;
  dock.monitors.insights = g.insights?.show !== false;
  return {
    ...DEFAULT_WALL_STATE,
    layout: sanitizeWallLayout(undefined),
    folded: {},
    dock,
    root,
    autoAdd: typeof g.autoAdd === 'boolean' ? g.autoAdd : true,
    filter: 'all',
    insights: readPanels(g.insights?.panels),
    watermark: readWatermark(g.watermark),
    composer: DEFAULT_COMPOSER_DOCK,
  };
}

/**
 * Read the saved wall. The setting wins when there is one (it is what the
 * desktop, web and phone editions of an install share); the browser's copy
 * is the fast first paint and the fallback for an install that has not saved
 * the setting yet, and the grid that came before this wall is carried over
 * when neither exists. A damaged entry falls back to an empty wall.
 */
export function loadWallState(storage: Pick<Storage, 'getItem'> | undefined, setting?: CommandWallSetting | null): CommandWallState {
  try {
    const raw = setting ? JSON.stringify(setting) : storage?.getItem(WALL_STATE_KEY);
    if (!raw) {
      const legacy = storage?.getItem(LEGACY_GRID_KEY);
      if (legacy) return migrateGridState(JSON.parse(legacy)) ?? DEFAULT_WALL_STATE;
      return DEFAULT_WALL_STATE;
    }
    const saved = record(JSON.parse(raw));
    const dock = sanitizeMonitorsDock(saved.dock);
    let maxSeq = 0;
    const root = sanitize(saved.root, (id) => { maxSeq = Math.max(maxSeq, idSeq(id)); }, dock);
    reserveIdSeq(maxSeq);
    return {
      root,
      layout: sanitizeWallLayout(saved.layout),
      dock,
      hero: typeof saved.hero === 'string' && saved.hero.length > 0 ? saved.hero : null,
      folded: readFolded(saved.folded),
      autoAdd: typeof saved.autoAdd === 'boolean' ? saved.autoAdd : true,
      // The Agents/Terminals filter left the toolbar (2026-10-17), so a wall
      // saved while filtered would hide windows with no way to show them.
      filter: 'all',
      insights: readPanels(record(saved.insights).panels),
      watermark: readWatermark(saved.watermark),
      composer: readDock(saved.composer),
      tabs: saved.tabs === 'left' || saved.tabs === 'hidden' ? saved.tabs : 'top',
      agentPanel: readAgentPanel(saved.agentPanel),
      snap: saved.snap === true,
      zones: saved.zones === true,
      activeZone: typeof saved.activeZone === 'string' ? saved.activeZone : null,
      zonesIntro: saved.zonesIntro === true,
    };
  } catch {
    return DEFAULT_WALL_STATE;
  }
}

export function saveWallState(storage: Pick<Storage, 'setItem'> | undefined, state: CommandWallState): void {
  try {
    storage?.setItem(WALL_STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode or full */
  }
}

/** The wall as the setting stores it: the same fields, typed loosely for the shared schema. */
export function toWallSetting(state: CommandWallState): CommandWallSetting {
  return { layout: state.layout, dock: state.dock, hero: state.hero, folded: state.folded, root: state.root, autoAdd: state.autoAdd, filter: state.filter, insights: state.insights, watermark: state.watermark, composer: state.composer, tabs: state.tabs, agentPanel: state.agentPanel, snap: !!state.snap, zones: !!state.zones, activeZone: state.activeZone ?? null, zonesIntro: !!state.zonesIntro };
}

/* ---------- the ribbon ---------- */

export type BlockedKind = 'question' | 'approval' | 'interrupted';

export interface RibbonItem {
  sessionId: string;
  title: string;
  blocked: BlockedKind;
  /** What is being asked, in a few words: the command an approval wants to run, else the kind of wait. */
  what: string;
  /** True when `what` is a command, so the view can set it in monospace. */
  command: boolean;
}

/** What an approval is asking for: the command when the call has one, else the tool's name. */
export function approvalSummary(p: PendingInput): string | null {
  const call = p.approval?.call;
  if (!call) return null;
  // `ToolCall.input` is the tool's arguments; the first cut of the ribbon read
  // a field called `arguments` and so never showed a command.
  const args = call.input && typeof call.input === 'object' ? call.input : {};
  const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : null;
  if (cmd) return cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
  return call.name || null;
}

/**
 * Everything waiting on a person, for the ribbon above the wall: one row per
 * chat with a pending approval or question, archived chats left out, in the
 * order the chats are listed.
 */
export function ribbonItems(sessions: SessionSummary[], pending: Record<string, PendingInput>): RibbonItem[] {
  const out: RibbonItem[] = [];
  for (const s of sessions) {
    const p = pending[s.id];
    if (!p || isArchived(s)) continue;
    const { blocked } = sessionLane({ running: false, pending: p });
    if (!blocked) continue;
    const cmd = blocked === 'approval' ? approvalSummary(p) : null;
    out.push({ sessionId: s.id, title: s.title, blocked, what: cmd ?? BLOCKED_META[blocked].label.toLowerCase(), command: !!cmd });
  }
  return out;
}
