import { terminalExcerpt } from './terminalExcerpt.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PendingInput, SessionSummary, TerminalInfo, WorkspaceFolder } from '@nekko-agent/shared';
import { BLOCKED_META, LANE_META, sessionLane } from '@nekko-agent/shared';
import {
  allPanes,
  canSplit,
  isSplit,
  movePane,
  movePaneToEdge,
  removePane,
  resizeSplit,
  splitPane,
  swapPanes,
  type Direction,
  type PaneKind,
  type WbNode,
  type WbPane,
} from '../layout.js';
import {
  DEFAULT_ASPECT,
  NARROW_ROW_H,
  NARROW_WIDTH,
  WALL_KINDS,
  addPane,
  addPanes,
  filterTree,
  leafRects,
  wallAgents,
  wallPane,
  type CommandWallState,
} from '../commandWall.js';
import { useStore, type Workspace } from '../store.js';
import { foldWindow, growWindow, mostOverlapping, outerSide, type Box } from '../wallMotion.js';
import { ChatPane } from './ChatPane.js';
import { FilePane } from './FilePane.js';
import { ExplorerPane } from './ExplorerPane.js';
import { WorkingSubagents } from './WorkingSubagents.js';
import { NumberedAgentIcon } from './NumberedChatIcon.js';
import { ZenIcon } from '../icons.js';
import { StatusIcon, agentStatusOfLane, type AgentStatus } from './WorkspaceCard.js';
import { BrowserPane } from './BrowserPane.js';
import { DiffPane } from './DiffPane.js';


/** Read the owning workspace, never synthesize or persist a second layout. */
export function workspaceCompanions(workspaces: Workspace[], sessionId: string): WbPane[] {
  const workspace = workspaces.find((w) => w.anchor.kind === 'chat' && w.anchor.refId === sessionId)
    ?? workspaces.find((w) => {
      const chats = allPanes(w.root).filter((p) => p.kind === 'chat');
      return w.anchor.kind !== 'chat' && chats.length === 1 && chats[0].refId === sessionId;
    });
  return allPanes(workspace?.root ?? null).filter((p) =>
    p.kind === 'file' || p.kind === 'files' || p.kind === 'browser' || (p.kind === 'diff' && p.refId === sessionId));
}

export function TerminalExcerpt({ terminalId }: { terminalId: string }) {
  const [text, setText] = useState('Reading terminal output…');
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void window.nekko.terminalSnapshot(terminalId).then(snap => {
      if (!disposed) setText(terminalExcerpt(snap?.buffer ?? ''));
    }).catch(() => { if (!disposed) setText('Terminal output unavailable'); }); };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [terminalId]);
  return <span className="font-mono whitespace-pre-wrap">{text}</span>;
}

/**
 * The drag handle between an agent and its companions. Sets a CSS variable on
 * the window's content box while dragging (no React render per pointer move),
 * then saves the share for that chat. Arrow keys nudge it; double-click resets.
 */
function CompanionResizer({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const apply = (share: number) => ref.current?.parentElement?.style.setProperty('--companion-share', `${(share * 100).toFixed(1)}%`);
  useLayoutEffect(() => { apply(readCompanionWidth(sessionId)); }, [sessionId]);
  const [share, setShare] = useState(() => readCompanionWidth(sessionId));
  const commit = (next: number) => { apply(next); setShare(next); saveCompanionWidth(sessionId, next); };
  const onPointerDown = (e: React.PointerEvent) => {
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    let last = share;
    const move = (ev: PointerEvent) => { last = shareFromPointer(ev.clientX, box.left, box.width); apply(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('wall-resizing'); commit(last); };
    document.body.classList.add('wall-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      ref={ref}
      className="command-wall-companion-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize companions"
      aria-valuemin={20}
      aria-valuemax={75}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(0.38)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); commit(Math.min(0.75, share + 0.04)); }
        if (e.key === 'ArrowRight') { e.preventDefault(); commit(Math.max(0.2, share - 0.04)); }
      }}
    />
  );
}

function CompanionBody({ pane }: { pane: WbPane }) {
  switch (pane.kind) {
    case 'file': return <FilePane path={pane.refId} />;
    case 'files': return <ExplorerPane paneId={pane.id} root={pane.refId} />;
    case 'browser': return <BrowserPane url={pane.refId} />;
    case 'diff': return <DiffPane sessionId={pane.refId} />;
    default: return null;
  }
}
import { COMPACT_HEIGHT, COMPACT_WIDTH, PaneDensityHint } from './agent-console/useElementWidth.js';
import { TerminalPane } from './TerminalPane.js';
import { PANE_DRAG_TYPE, PaneActions, PaneFrame } from './PaneFrame.js';
import { Divider } from './Divider.js';
import { WallEmptyIllustration } from './WallEmptyIllustration.js';
import { AgentLogsDrawer } from './AgentLogsDrawer.js';
import { layoutWithLogsDrawer, overlayLogsDrawer, useWallLogs } from '../wallLogs.js';
import { BoltIcon, ChatIcon, CloseIcon, ExternalIcon, LayoutIcon, TerminalIcon } from '../icons.js';
import { readCompanionWidth, saveCompanionWidth, shareFromPointer } from './companionWidth.js';
import './commandWallLayouts.css';
import { PaneVisibleContext } from '../paneVisibility.js';

/** The kinds the wall's compass offers, in order. */
const WALL_ADDABLE: PaneKind[] = [...WALL_KINDS];

/** How many Focus heroes keep their composer mounted while parked. */
export const WARM_COMPOSERS = 4;

/** `ids` with `id` moved to the front, at most `max` long; `ids` itself when nothing moves. */
export function warmFront(ids: readonly string[], id: string, max = WARM_COMPOSERS): readonly string[] {
  if (ids[0] === id) return ids;
  return [id, ...ids.filter((x) => x !== id)].slice(0, max);
}

export const sameDeps = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * One wall window, rendered again only when something it shows changes. A
 * switch changes two windows (the one leaving and the one arriving); without
 * this every window on the wall, a dozen frames with their toolbars and
 * icons, re-rendered on every switch. `render` reads the latest values, and
 * every handler inside goes through the wall's `live` ref, so a window that
 * skipped a render never calls a stale callback.
 */
const WallLeaf = React.memo(
  function WallLeaf({ render }: { render: () => React.ReactNode; deps: readonly unknown[] }) { return <>{render()}</>; },
  (a, b) => sameDeps(a.deps, b.deps),
);

export interface WallGeometry {
  panes: Map<string, { x: number; y: number; width: number; height: number }>;
  deck: Set<string>;
  hero: string | null;
  height: number;
  add: { x: number; y: number; width: number; height: number };
  /** Display tree retaining real split identities; Add has its own geometry. */
  addGrid: WbNode | null;
  grid: WbNode | null;
  stageHeight: number;
  /** Grid (fixed) only: the cells no window fills, drawn as quiet placeholders. */
  empty: Array<{ x: number; y: number; width: number; height: number }>;
}

/** Expand companion-bearing leaves for display only; never write these ratios back. */
export function companionTree(root: WbNode | null, expanded: Set<string>, factor = 1.9): WbNode | null {
  if (!root || !isSplit(root)) return root;
  const weights = root.children.map((child, i) => root.sizes[i] * (root.dir === 'row' && allPanes(child).some(p => expanded.has(p.id)) ? factor : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  return { ...root, children: root.children.map(child => companionTree(child, expanded, factor)!), sizes: weights.map(w => w / total) };
}

export function resizeCompanionSplit(root: WbNode | null, expanded: Set<string>, id: string, index: number, fraction: number): WbNode | null {
  return companionTree(resizeSplit(companionTree(root, expanded), id, index, fraction), expanded, 1 / 1.9);
}

/** Pixel geometry only; the saved split tree is never re-tiled by a mode switch. */
export function commandWallGeometry(state: CommandWallState, width: number, height: number, expanded = new Set<string>(), preview = false): WallGeometry {
  const tree = filterTree(state.root, state.filter);
  const visible = allPanes(tree);
  const hero = state.layout.mode === 'focus'
    ? (visible.find((p) => p.refId === state.hero) ?? visible[0])?.id ?? null : null;
  const deckPanes = visible.filter((p) => state.layout.mode === 'focus' && p.id !== hero);
  const deck = new Set(deckPanes.map((p) => p.id));
  const panes: WallGeometry['panes'] = new Map();
  const gap = 8;
  // Idle walls reserve nothing for Add: the button sits beside the composer.
  const rail = 0;
  const deckHeight = state.layout.mode === 'focus' ? 0 : Math.max(240, Math.min(440, width / 3));
  // A stacked Focus chat needs space for transcript, approval and composer
  // above its companion. The wall scrolls when the viewport cannot fit them.
  const minimum = state.layout.mode === 'focus' && width > 0 && width < 640 ? 960 : 240;
  let stageHeight = Math.max(minimum, height);
  const active = visible.filter((p) => !deck.has(p.id));
  const grid = deckPanes.reduce<WbNode | null>((root, p) => removePane(root, p.id), tree);
  // Idle geometry keeps saved ratios. Clicking uses display-only insertion;
  // never persist the preview tree or expose its synthetic dividers.
  const previewPane: WbPane = { id: '__wall_add__', kind: 'chat', refId: '__wall_add__' };
  const addGrid = companionTree(preview && state.layout.mode === 'grid' ? addPane(grid, previewPane, width / Math.max(1, stageHeight)) : grid, expanded);
  // Use the measured space remaining beside/above the composer, not a
  // width-derived aspect floor that makes wide windows overflow the viewport.
  let contentHeight = stageHeight;
  if (state.layout.mode === 'focus') {
    if (hero) panes.set(hero, { x: 0, y: 0, width, height: stageHeight });
  } else if (state.layout.mode === 'fixed' || width < NARROW_WIDTH) {
    const cols = width < NARROW_WIDTH ? 1 : state.layout.cols;
    const rowHeight = width < NARROW_WIDTH ? NARROW_ROW_H : Math.max(160, (stageHeight - gap * (state.layout.rows - 1)) / state.layout.rows);
    const cellWidth = Math.max(0, (width - gap * (cols - 1)) / cols);
    // Fixed overflow adds rows rather than hiding live windows beyond capacity.
    const slots = active.length + (preview ? 1 : 0);
    contentHeight = Math.max(stageHeight, Math.ceil(slots / cols) * (rowHeight + gap) - gap);
    active.forEach((p, i) => panes.set(p.id, { x: (i % cols) * (cellWidth + gap), y: Math.floor(i / cols) * (rowHeight + gap), width: cellWidth, height: rowHeight }));
    const i = active.length;
    const add = { x: (i % cols) * (cellWidth + gap), y: Math.floor(i / cols) * (rowHeight + gap), width: cellWidth, height: rowHeight };
    if (!preview) Object.assign(add, { x: width, y: contentHeight, width: 0, height: rail });
    deckPanes.forEach((p, i) => panes.set(p.id, { x: i * 248, y: contentHeight + gap, width: 240, height: 160 }));
    // Every cell of the chosen grid (and the rest of an overflow row) that no
    // window or Add slot takes. A one-column phone stack has no empty squares.
    const empty: WallGeometry['empty'] = [];
    if (width >= NARROW_WIDTH) {
      const cells = Math.max(cols * state.layout.rows, Math.ceil(slots / cols) * cols);
      for (let c = slots; c < cells; c++) empty.push({ x: (c % cols) * (cellWidth + gap), y: Math.floor(c / cols) * (rowHeight + gap), width: cellWidth, height: rowHeight });
    }
    return { panes, deck, hero, height: contentHeight + (deck.size ? 168 + gap : 0), add, addGrid: grid, grid, stageHeight, empty };
  } else {
    const rectOf = (r: { x: number; y: number; width: number; height: number }) => ({
      x: r.x * width + (r.x > 0 ? gap / 2 : 0),
      y: r.y * stageHeight + (r.y > 0 ? gap / 2 : 0),
      width: Math.max(0, r.width * width - (r.x > 0 ? gap / 2 : 0) - (r.x + r.width < 1 - 1e-6 ? gap / 2 : 0)),
      height: Math.max(0, r.height * stageHeight - (r.y > 0 ? gap / 2 : 0) - (r.y + r.height < 1 - 1e-6 ? gap / 2 : 0)),
    });
    for (const [id, r] of leafRects(addGrid)) panes.set(id, rectOf(r));
    const add = preview ? panes.get('__wall_add__') ?? { x: 0, y: stageHeight + gap, width, height: 240 } : { x: width, y: stageHeight, width: 0, height: rail };
    panes.delete('__wall_add__');
    return { panes, deck, hero, height: stageHeight, add, addGrid, grid, stageHeight, empty: [] };
  }
  // Focus keeps other bodies warm but selects them through the row above the hero.
  return { panes, deck, hero, height: state.layout.mode === 'focus' ? contentHeight : contentHeight + gap + deckHeight, add: { x: 0, y: contentHeight + gap, width: Math.min(width, Math.max(280, width / 3)), height: 240 }, addGrid, grid, stageHeight, empty: [] };
}

const BOARD_EDGES: Direction[] = ['up', 'down', 'left', 'right'];

/**
 * Where a window dragged to one side of the whole Dynamic board would end up,
 * in stage pixels: a full-height column on the left or right, a full-width
 * row on the top or bottom. Null when that drop would change nothing.
 */
export function boardEdgePreview(state: CommandWallState, paneId: string, side: Direction, width: number, height: number, expanded = new Set<string>()): { x: number; y: number; width: number; height: number } | null {
  const moved = movePaneToEdge(state.root, paneId, side);
  if (!moved || moved === state.root) return null;
  const r = leafRects(companionTree(filterTree(moved, state.filter), expanded)).get(paneId);
  if (!r) return null;
  const before = leafRects(companionTree(filterTree(state.root, state.filter), expanded)).get(paneId);
  if (before && Math.abs(before.x - r.x) < 1e-6 && Math.abs(before.y - r.y) < 1e-6 && Math.abs(before.width - r.width) < 1e-6 && Math.abs(before.height - r.height) < 1e-6) return null;
  return { x: r.x * width, y: r.y * height, width: r.width * width, height: r.height * height };
}

/** Stable keyed windows across layouts keep transcripts, terminals and drafts warm. */
export function CommandWall({
  state,
  setState,
  sessions,
  terminals,
  running,
  pending,
  childrenOf,
  projects,
  flash,
  selectedId,
  onSelect,
  onAspect,
  onOpenChat,
  onOpenTerminal,
  onNewChat,
  onNewTerminal,
  onAddWindow,
  addContent,
}: {
  state: CommandWallState;
  setState: (update: (s: CommandWallState) => CommandWallState) => void;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  running: Set<string>;
  pending: Record<string, PendingInput>;
  childrenOf: Map<string, SessionSummary[]>;
  projects: WorkspaceFolder[];
  /** The window the ribbon just jumped to, flashed once. */
  flash: { paneId: string; at: number } | null;
  /** The agent the wall's composer is speaking for. */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** The stage's width over height as it is measured, for placing windows nobody pointed at a side for. */
  onAspect: (aspect: number) => void;
  onOpenChat: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  /** Start a chat; resolves to its id once the session list knows it. */
  onNewChat: () => Promise<string>;
  onNewTerminal: () => Promise<string>;
  onAddWindow: () => void;
  addContent?: React.ReactNode;
}) {
  const workspaces = useStore((s) => s.workspaces);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const createRef = useRef<HTMLDivElement>(null);
  const [createHeight, setCreateHeight] = useState(0);
  useLayoutEffect(() => {
    const el = createRef.current;
    if (!el) { setCreateHeight(0); return; }
    const measure = () => setCreateHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    return () => observer.disconnect();
  }, [!!addContent]);




  // The wall fills the window from where it starts down to the bottom and
  // re-measures when its box changes (the ribbon appearing, a resize).
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Geometry lives inside the padded stage. Including its padding feeds
    // intrinsic narrow-layout height back into ResizeObserver on every frame.
    const style = getComputedStyle(el);
    const width = Math.round(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const height = Math.round(el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    // Hidden behind another view the wall measures nothing; keep the last real
    // size so its windows stay mounted and warm until it is shown again.
    if (width === 0 || height === 0) return;
    onAspect(Math.max(1, width) / Math.max(1, height));
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, [onAspect]);
  useLayoutEffect(() => {
    measure();
    const el = wrapRef.current;
    const ro = el ? new ResizeObserver(() => measure()) : null;
    if (el && ro) ro.observe(el);
    // A wall mounted while its window had no size (a hidden web tab, a
    // minimised window) gets a second chance when the window resizes or
    // comes back into view, in case the observer's first notice was lost.
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
    };
  }, [measure]);

  // The side of the whole board a dragged window is over, in Dynamic.
  const [edgeOver, setEdgeOver] = useState<Direction | null>(null);
  useEffect(() => { if (!dragging) setEdgeOver(null); }, [dragging]);

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

  // The ribbon's jump: scroll the window into view, ring it once, and put the
  // caret in its composer so the answer can be typed straight away.
  useEffect(() => {
    if (!flash) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-wall-pane="${flash.paneId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const input = el.querySelector<HTMLElement>('[contenteditable]:not([contenteditable="false"]), textarea');
    input?.focus({ preventScroll: true });
  }, [flash]);

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // The agent windows' numbers, in reading order of the whole wall (not the
  // filtered view), so a number means the same window whatever is shown.
  const numberOf = useMemo(() => new Map(wallAgents(state.root).map((p, i) => [p.refId, i + 1])), [state.root]);
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : DEFAULT_ASPECT;
  const { geometry, expanded } = useMemo(() => {
    const base = commandWallGeometry(state, size.width, size.height, new Set(), !!addContent);
    if (state.layout.mode !== 'grid') return { geometry: base, expanded: new Set<string>() };
    const expanded = new Set(wallAgents(state.root).filter(p => workspaceCompanions(workspaces, p.refId).length > 0 && !(state.folded[p.refId] ?? (numberOf.size > 4 || (base.panes.get(p.id)?.width ?? 0) < 700))).map(p => p.id));
    return { geometry: expanded.size ? commandWallGeometry(state, size.width, size.height, expanded, !!addContent) : base, expanded };
  }, [state.root, state.filter, state.layout, state.hero, state.folded, workspaces, numberOf, size, !!addContent]);
  // An agent's log drawer, out of its window's right edge: the wall moves the
  // windows beside it over. While it is being absorbed back the layout is
  // already the closed one, so the neighbours slide back in step.
  const logsFor = useWallLogs((s) => s.sessionId);
  const logsClosing = useWallLogs((s) => s.closing);
  const logsPane = logsFor ? allPanes(state.root).find((p) => p.kind === 'chat' && p.refId === logsFor && geometry.panes.has(p.id) && !geometry.deck.has(p.id)) : undefined;
  // A one-column wall has no room to make: the drawer sits over its window.
  const logsLayout = useMemo(() => !logsPane ? null : size.width >= NARROW_WIDTH ? layoutWithLogsDrawer(geometry.panes, logsPane.id, size.width) : overlayLogsDrawer(geometry.panes, logsPane.id), [geometry, logsPane?.id, size.width]);
  const logsOverlay = !!logsLayout && 'overlay' in logsLayout;
  const shownPanes = logsLayout && !logsClosing ? logsLayout.panes : geometry.panes;
  // A drawer whose window left the wall closes.
  useEffect(() => { if (logsFor && size.width > 0 && !logsLayout) { useWallLogs.setState({ sessionId: null, closing: false }); } }, [logsFor, logsLayout, size.width]);
  const densityOf = (paneId: string): boolean | null => {
    const r = geometry.panes.get(paneId);
    return !r || size.width === 0 ? null : r.width < COMPACT_WIDTH || r.height - 32 < COMPACT_HEIGHT;
  };
  const seenCompanions = useRef(new Map<string, number>());
  const [companionNotice, setCompanionNotice] = useState<WbPane | null>(null);
  useEffect(() => {
    if (!size.width) return;
    for (const pane of wallAgents(state.root)) {
      const count = workspaceCompanions(workspaces, pane.refId).length;
      const previous = seenCompanions.current.get(pane.refId) ?? 0;
      if (count > previous && state.layout.mode === 'grid' && (geometry.panes.get(pane.id)?.width ?? 0) < 700) setCompanionNotice(pane);
      seenCompanions.current.set(pane.refId, count);
    }
  }, [workspaces, state.root, state.layout.mode, geometry, size.width]);
  const focusWindow = (pane: WbPane) => {
    setState((s) => ({ ...s, layout: { ...s.layout, mode: 'focus' }, hero: pane.refId }));
    if (pane.kind === 'chat') onSelect(pane.refId);
  };

  const update = useCallback((fn: (root: WbNode | null) => WbNode | null) => setState((s) => {
    const root = fn(s.root);
    return root === s.root ? s : { ...s, root };
  }), [setState]);

  const isRunning = useCallback(
    (s: SessionSummary): boolean => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => isRunning(k)),
    [running, childrenOf],
  );

  /**
   * Put a new window on the given side of `paneId`, or, with no side, beside
   * the biggest window there is. A chat or shell is created first and its id
   * comes back; the panels point at themselves and exist once at most, so
   * asking for one that is already up moves it rather than doubling it.
   */
  const addWindow = async (kind: PaneKind, at?: { paneId: string; dir: Direction }) => {
    let refId: string = kind;
    if (kind === 'chat') refId = await onNewChat();
    else if (kind === 'terminal') refId = await onNewTerminal();
    update((root) => {
      let next = root;
      const existing = allPanes(next).find((p) => p.kind === kind && p.refId === refId);
      // Auto-add may already have placed a brand-new chat; the side the user
      // pointed at wins, so lift it out and put it there.
      if (existing) {
        if (!at) return next;
        next = removePane(next, existing.id);
      }
      const pane = existing ? { ...existing } : wallPane(kind, refId);
      if (at && allPanes(next).some((p) => p.id === at.paneId) && canSplit(next, at.paneId, at.dir)) return splitPane(next, at.paneId, at.dir, pane);
      return addPane(next, pane, aspect);
    });
  };

  // What the windows' handlers need, read when they run: a window that skipped
  // a render (WallLeaf) still acts on the current wall.
  const live = useRef({ state, dragging, aspect, setState, update, onSelect, onOpenChat, onOpenTerminal, focusWindow, addWindow });
  live.current = { state, dragging, aspect, setState, update, onSelect, onOpenChat, onOpenTerminal, focusWindow, addWindow };
  // The Focus heroes seen last keep their composer while parked, so going back
  // to one is a visibility flip; the rest park as transcripts.
  const warm = useRef<readonly string[]>([]);
  if (state.layout.mode === 'focus' && state.hero) warm.current = warmFront(warm.current, state.hero);
  // Leaving Focus, the parked windows jump to their places instead of sliding
  // there from under the hero: a dozen full-size windows animating down at
  // once rastered every one of them whole (hundreds of MB of tiles, kept).
  // Only the hero slides, as it did before windows were parked.
  const lastFocusHero = useRef<string | null>(null);
  const prevMode = useRef(state.layout.mode);
  const leavingFocus = prevMode.current === 'focus' && state.layout.mode !== 'focus';
  const [unparked, setUnparked] = useState<string | null | undefined>(undefined);
  const snapping = leavingFocus || unparked !== undefined;
  const snapHero = leavingFocus ? lastFocusHero.current : unparked;
  if (state.layout.mode === 'focus') lastFocusHero.current = geometry.hero;
  useLayoutEffect(() => {
    const left = prevMode.current === 'focus' && state.layout.mode !== 'focus';
    prevMode.current = state.layout.mode;
    if (!left) return;
    setUnparked(lastFocusHero.current);
    // Two frames: the jump has been styled by then, so turning transitions
    // back on starts none.
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setUnparked(undefined)); });
    return () => { cancelAnimationFrame(id); setUnparked(undefined); };
  }, [state.layout.mode]);

  // Opening and closing a window is one push (wallMotion.ts): the windows
  // beside it slide on their transition while it opens out of, or folds into,
  // its outer edge in step. Only for windows that joined or left the wall
  // itself, never for a filter, a layout switch or the first paint.
  const pushStageRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef<HTMLDivElement>(null);
  const lastPush = useRef<{ ids: Set<string>; boxes: ReadonlyMap<string, Box>; els: Map<string, HTMLElement>; mode: string } | null>(null);
  useLayoutEffect(() => {
    const stage = pushStageRef.current;
    if (!stage) return;
    const ids = new Set(allPanes(state.root).map((p) => p.id));
    const els = new Map<string, HTMLElement>();
    stage.querySelectorAll<HTMLElement>(':scope > [data-wall-pane]').forEach((el) => els.set(el.dataset.wallPane!, el));
    const before = lastPush.current;
    lastPush.current = size.width > 0 ? { ids, boxes: new Map(shownPanes), els, mode: state.layout.mode } : null;
    if (!before || before.mode !== state.layout.mode || state.layout.mode === 'focus' || snapping) return;
    for (const id of ids) {
      if (before.ids.has(id)) continue;
      const box = shownPanes.get(id);
      const el = els.get(id);
      if (!box || !el) continue;
      // The window whose room it took was pushed away from it.
      const from = mostOverlapping(box, [...before.boxes].filter(([other]) => ids.has(other)));
      void growWindow(el, outerSide(box, from ? shownPanes.get(from) : undefined));
    }
    const layer = leavingRef.current;
    if (!layer) return;
    for (const id of before.ids) {
      if (ids.has(id)) continue;
      const box = before.boxes.get(id);
      const el = before.els.get(id);
      if (!box || !el) continue;
      // The window that fills its room grows in from the other side.
      const into = mostOverlapping(box, [...shownPanes].filter(([other]) => before.ids.has(other)));
      foldWindow(el, layer, outerSide(box, into ? before.boxes.get(into) : undefined));
    }
  });

  const titleOf = (pane: WbPane): string => {
    if (pane.kind === 'chat') return sessionById.get(pane.refId)?.title ?? 'Chat';
    if (pane.kind === 'terminal') return terminalById.get(pane.refId)?.title || 'Terminal';
    return pane.kind === 'automations' ? 'Automations' : 'Insights';
  };
  const iconOf = (kind: PaneKind) => {
    const cls = 'h-3.5 w-3.5 shrink-0 text-ink-faint';
    if (kind === 'terminal') return <TerminalIcon className={cls} />;
    if (kind === 'automations') return <BoltIcon className={cls} />;
    if (kind === 'insights') return <LayoutIcon className={cls} />;
    return <ChatIcon className={cls} />;
  };

  const renderLeaf = (pane: WbPane) => {
    const session = pane.kind === 'chat' ? sessionById.get(pane.refId) : undefined;
    const terminal = pane.kind === 'terminal' ? terminalById.get(pane.refId) : undefined;
    const project = projects.find((p) => p.id === (session?.workspaceId ?? terminal?.workspaceId));
    let status: { label: string; tone: string; live?: boolean } | null = null;
    let needsYou = false;
    let agentStatus: AgentStatus | undefined;
    if (session) {
      const { lane, blocked } = sessionLane({ running: isRunning(session), pending: pending[session.id], stalled: session.stalled });
      needsYou = lane === 'needs-you';
      agentStatus = agentStatusOfLane(lane, blocked);
      status = needsYou && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone, live: true } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
    } else if (terminal) {
      status = terminal.running ? { label: 'live', tone: 'var(--success)' } : { label: 'exited', tone: 'var(--ink-faint)' };
    }
    const title = titleOf(pane);
    const flashing = flash?.paneId === pane.id;
    const openable = pane.kind === 'chat' || pane.kind === 'terminal';
    const selected = pane.kind === 'chat' && pane.refId === selectedId;
    const n = pane.kind === 'chat' ? numberOf.get(pane.refId) : undefined;

    const rect = shownPanes.get(pane.id);
    const hero = geometry.hero === pane.id;
    const focusedChat = pane.kind === 'chat' && state.layout.mode === 'focus' && hero;
    const folded = state.folded[pane.refId] ?? (!focusedChat && (numberOf.size > 4 || (state.layout.mode === 'grid' && (rect?.width ?? 0) < 700)));
    const showCompanions = focusedChat ? !(state.folded[pane.refId] ?? false) : !folded && state.layout.mode === 'grid';
    const inDeck = geometry.deck.has(pane.id);
    // Focus shows one window. The others are parked under it at its size but
    // not rendered (content-visibility: hidden), so returning to one reuses
    // its styles and layout instead of rebuilding them from display: none.
    const heroRect = !rect && inDeck && state.layout.mode === 'focus' && geometry.hero ? shownPanes.get(geometry.hero) : undefined;
    const parked = !!heroRect;
    const box = rect ?? heroRect;
    // A parked window keeps what the hero has (no deck styling, not inert, the
    // Focus attribute): flipping any of them on a switch restyles its whole
    // transcript, and content-visibility: hidden already keeps it out of
    // sight, focus and the accessibility tree.
    const deckCard = inDeck && !parked;
    // A recent hero keeps its composer while parked; the others park as transcripts.
    const fullSurface = focusedChat || (parked && warm.current.includes(pane.refId));
    // Parked at the hero's size, so at its density too: nothing in the window changes when it comes back.
    const density = densityOf(parked && geometry.hero ? geometry.hero : pane.id);
    const logsOpen = logsPane?.id === pane.id && !logsClosing && !logsOverlay;
    const subagents = session ? childrenOf.get(session.id) : undefined;
    const snap = snapping && pane.id !== snapHero;
    const deps = [
      pane, title, session, terminal, project?.name, projects.length > 1, status?.label, status?.live, needsYou, agentStatus,
      flashing, selected, n, box?.x, box?.y, box?.width, box?.height, parked, hero, focusedChat, folded, showCompanions,
      inDeck, fullSurface, density, logsOpen, snap, workspaces, dragging, state.layout.mode, state.root, subagents, running, pending,
    ];
    return <WallLeaf key={pane.id} deps={deps} render={() => {
      const companions = pane.kind === 'chat' ? workspaceCompanions(workspaces, pane.refId) : [];
      return (
      <div
        className={`command-wall-window ${deckCard ? 'command-wall-deck-window' : ''} ${flashing ? 'pane-flash' : ''}`}
        style={box ? { left: box.x, top: box.y, width: box.width, height: box.height } : { display: 'none' }}
        data-wall-parked={parked || undefined}
        data-wall-snap={snap || undefined}
        data-wall-deck={inDeck || undefined}
        data-wall-hero={hero || undefined}
        data-wall-pane={pane.id}
        data-grid-cell={`${pane.kind}:${pane.refId}`}
        data-wall-selected={selected || undefined}
        data-wall-working={agentStatus === 'working' || undefined}
        data-wall-needs-you={needsYou || undefined}
        data-wall-logs-open={logsOpen || undefined}
      >
        {/* The composer's beam, quieter: a working agent window says so at a glance. */}
        {agentStatus === 'working' && <span className="composer-beam-ring wall-window-beam" aria-hidden><span className="composer-beam-spin" /></span>}
        <PaneFrame
          pane={pane}
          title={title}
          icon={pane.kind === 'chat' ? <><span data-agent-status><StatusIcon status={agentStatus} /></span><NumberedAgentIcon number={n} /></> : iconOf(pane.kind)}
          // Activity precedes the numbered agent icon; terminals keep their strip dot.
          statusIndicator={session ? undefined : status && <span role="img" aria-label={status.label} title={status.label} className="h-2 w-2 shrink-0 rounded-full" style={{ background: status.live ? 'var(--success)' : 'var(--ink-faint)' }} />}
          badge={
            <>
              {/* The project only when there is more than one to tell apart:
                  on a one-project wall it is the same word on every strip. */}
              {project && projects.length > 1 && !density && <span className="chip hidden shrink-0 text-[10px] sm:inline">{project.name}</span>}
            </>
          }
          isActive={false}
          ringColor={flashing ? 'color-mix(in srgb, var(--accent) 60%, var(--line))' : undefined}
          stripStyle={needsYou ? { background: 'color-mix(in srgb, var(--warning) 10%, transparent)' } : undefined}
          addable={WALL_ADDABLE}
          closeTitle={openable ? 'Remove from the wall (the chat stays)' : 'Remove from the wall'}
          dragging={dragging}
          canSplit={(dir) => state.layout.mode === 'grid' && !inDeck && canSplit(state.root, pane.id, dir)}
          onAddWindow={() => live.current.setState((s) => s.layout.mode === 'focus' ? { ...s, layout: { ...s.layout, mode: 'grid' } } : s)}
          onSplit={(dir, kind) => { void live.current.addWindow(kind, { paneId: pane.id, dir }); }}
          onClose={() => live.current.update((root) => removePane(root, pane.id))}
          focusAction={openable && <button type="button" className="command-wall-action agent-zen-action" title="Zen: focus this window (Ctrl+Shift+1)" aria-label={`Focus ${title}`} onClick={() => live.current.focusWindow(pane)}><ZenIcon className="h-5 w-5" /></button>}
          onMinimize={() => live.current.update((root) => removePane(root, pane.id))}
          onFocus={() => { if (pane.kind === 'chat') live.current.onSelect(pane.refId); }}
          onDragStart={() => setDragging(pane.id)}
          onDragEnd={() => setDragging(null)}
          onDrop={(target) => {
            const { dragging, state, update } = live.current;
            if (dragging) update((root) => (target === 'swap' || state.layout.mode !== 'grid' ? swapPanes(root, dragging, pane.id) : movePane(root, dragging, pane.id, target)));
            setDragging(null);
          }}
        >
          {/* What it is waiting on is said inside the window (ChatPane pins the
              question or approval at the top). A banner here sat under the
              absolutely positioned content and could not be seen. */}
          {deckCard && <button className="command-wall-card" onClick={() => live.current.focusWindow(pane)} aria-label={`Focus ${title}`}>{terminal ? <TerminalExcerpt terminalId={terminal.id} /> : <span>{session?.lastReplyText || 'No reply yet'}</span>}<small>{session ? `${session.modelId || 'Default model'} · ${session.transcriptTokens.toLocaleString()} context tokens` : status?.label}</small></button>}
          <div className="command-wall-content" inert={!box || deckCard} aria-hidden={!box || deckCard || undefined} data-companions-visible={showCompanions && companions.length > 0 || undefined} data-focus-chat={(focusedChat || parked) || undefined}>

            <div className="command-wall-primary">
           {pane.kind === 'chat' ? <PaneVisibleContext.Provider value={!parked}><PaneDensityHint.Provider value={density}><ChatPane key={pane.refId} sessionId={pane.refId} commandCenter surface={fullSurface ? 'full' : 'transcript'} status={agentStatus ?? 'idle'} selected={fullSurface ? undefined : selected} /></PaneDensityHint.Provider></PaneVisibleContext.Provider>
            : pane.kind === 'terminal' ? <TerminalPane key={pane.refId} terminalId={pane.refId} />
            : null}
           </div>
            {pane.kind === 'chat' && showCompanions && companions.length > 0 && <CompanionResizer sessionId={pane.refId} />}
            <div className="command-wall-companions" inert={!showCompanions || !rect} aria-hidden={!showCompanions || !rect || undefined}>
              {/* Kept mounted while folded so a browser keeps its page; see the stable-bodies test. */}
              {companions.map((companion) => {
                const label = companion.kind === 'diff' ? 'Changes' : companion.kind === 'files' ? 'Files' : companion.kind === 'browser' ? 'Browser' : companion.refId;
                return <section key={companion.id} className="command-wall-companion" data-companion-kind={companion.kind}>
                  <header><span title={companion.refId}>{label}</span><button type="button" className="command-wall-companion-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => useStore.getState().closePane(companion.id)}><CloseIcon className="h-4 w-4" /></button></header>
                  <div className="command-wall-companion-body"><CompanionBody pane={companion} /></div>
                </section>;
              })}
            </div>
          </div>
          {session && <WorkingSubagents children={subagents ?? []} running={running} pending={pending} onOpen={(id) => { const { update, aspect, onSelect } = live.current; update((root) => allPanes(root).some(p => p.kind === 'chat' && p.refId === id) ? root : addPane(root, wallPane('chat', id), aspect)); onSelect(id); }} />}
        </PaneFrame>
      </div>
      );
    }} />;
  };

  // Each divider retains its original split box as its parent so pointer and
  // keyboard resize fractions still address the saved tree, not the whole wall.
  const sourceSplitIds = new Set<string>();
  const collectSplits = (node: WbNode | null): void => { if (node && isSplit(node)) { sourceSplitIds.add(node.id); node.children.forEach(collectSplits); } };
  collectSplits(state.root);
  const renderDividers = (node: WbNode, r = { x: 0, y: 0, width: size.width, height: geometry.stageHeight }): React.ReactNode => {
    if (!isSplit(node)) return null;
    let at = 0;
    return node.children.map((child, i) => {
      const share = node.sizes[i];
      const fraction = at;
      const childRect = node.dir === 'row' ? { ...r, x: r.x + at * r.width, width: share * r.width } : { ...r, y: r.y + at * r.height, height: share * r.height };
      at += share;
      return <React.Fragment key={child.id}>
        {i > 0 && sourceSplitIds.has(node.id) && <div className="command-wall-divider-box" style={{ left: r.x, top: r.y, width: r.width, height: r.height,
          '--wall-divider-left': `${node.dir === 'row' ? fraction * r.width - 4 : 0}px`,
          '--wall-divider-top': `${node.dir === 'col' ? fraction * r.height - 4 : 0}px`,
          '--wall-divider-width': `${node.dir === 'row' ? 8 : r.width}px`,
          '--wall-divider-height': `${node.dir === 'col' ? 8 : r.height}px`,
        } as React.CSSProperties}>
          <Divider splitId={node.id} index={i - 1} dir={node.dir} onResize={(id, index, value) => update((root) => resizeCompanionSplit(root, expanded, id, index, value))} />
        </div>}
        {renderDividers(child, childRect)}
      </React.Fragment>;
    });
  };

  return (
    <div ref={wrapRef} className="command-wall-layout" data-command-wall="windows" data-wall-layout={state.layout.mode}>
      {companionNotice && <div className="command-wall-notice" role="status">A companion opened in a narrow window. <button onClick={() => { focusWindow(companionNotice); setCompanionNotice(null); }}>Focus {titleOf(companionNotice)}</button><button aria-label="Dismiss companion notice" onClick={() => setCompanionNotice(null)}>×</button></div>}
      <div className="command-wall-stage" data-wall-vacant={!addContent && !state.root || undefined} style={{ height: Math.max(geometry.height, addContent ? geometry.add.y + createHeight + 64 : 0), width: size.width }}>
        <div ref={pushStageRef} className="command-wall-pane-stage" style={{ position: 'absolute', inset: 0, top: 0 }}>
        {/* Closing windows fold away here, under the live ones; React never renders into it. */}
        <div ref={leavingRef} className="command-wall-leaving" aria-hidden />
        {/* Grid's unfilled squares, drawn under the windows as quiet hatching. */}
        {state.layout.mode === 'fixed' && geometry.panes.size > 0 && geometry.empty.map((r, i) => (
          <div key={`empty-${i}`} className="command-wall-empty-cell" aria-hidden data-wall-empty-cell style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />
        ))}
        {allPanes(state.root).map(renderLeaf)}
        {logsPane && logsLayout?.drawer && <AgentLogsDrawer key={logsPane.refId} sessionId={logsPane.refId} title={titleOf(logsPane)} rect={logsLayout.drawer} overlay={logsOverlay} selected={logsPane.refId === selectedId} />}
        {!addContent && state.layout.mode === 'grid' && size.width >= NARROW_WIDTH && geometry.addGrid && renderDividers(geometry.addGrid)}
        {/* Dynamic: each side of the whole board is a landing zone too, so a
            window can become a full-height column or a full-width row without
            aiming at another window. The preview shows where it would land. */}
        {dragging && !addContent && state.layout.mode === 'grid' && size.width >= NARROW_WIDTH && allPanes(state.root).length > 1 && <>
          {edgeOver && (() => {
            const r = boardEdgePreview(state, dragging, edgeOver, size.width, geometry.stageHeight, expanded);
            return r && <div className="command-wall-edge-preview" aria-hidden data-edge={edgeOver} style={{ left: r.x, top: r.y, width: r.width, height: r.height }}>
              <span>{edgeOver === 'left' || edgeOver === 'right' ? 'New column' : 'Full-width row'}</span>
            </div>;
          })()}
          {BOARD_EDGES.map((side) => (
            <div
              key={side}
              className="command-wall-edge"
              data-edge={side}
              data-over={edgeOver === side || undefined}
              aria-hidden
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (edgeOver !== side) setEdgeOver(side);
              }}
              onDragLeave={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !e.currentTarget.contains(to)) setEdgeOver((s) => (s === side ? null : s));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const { dragging, update } = live.current;
                if (dragging) update((root) => movePaneToEdge(root, dragging, side));
                setEdgeOver(null);
                setDragging(null);
              }}
            />
          ))}
        </>}
        </div>
        {/* Add window lives beside the composer; the wall only shows the slot it opens. */}
        {addContent && <div className="command-wall-add-zone">
          {<section className={`command-wall-add${addContent ? ' command-wall-add-tile' : ''}`} data-preview={!!addContent || undefined} data-solid={!!addContent || undefined} style={{ left: geometry.add.x, top: geometry.add.y, width: geometry.add.width, height: addContent ? Math.max(createHeight + 64, geometry.add.height) : geometry.add.height, position: 'absolute' }}>
            <div className="command-wall-add-heading">Add to the wall</div><div ref={createRef} id="wall-window-picker" className="command-wall-create">{addContent}</div>
          </section>}
        </div>}
        {!addContent && !filterTree(state.root, state.filter) && <div className="command-wall-empty">{state.root ? 'No windows match this filter.' : <div className="command-wall-empty-state" data-wall-empty><WallEmptyIllustration /><p className="command-wall-empty-title">The wall is empty</p><p>Agents, terminals and panels you add show up here as windows. <button type="button" className="text-accent hover:underline" onClick={onAddWindow} aria-label="Add window">Add a window</button> to get started.</p></div>}</div>}
      </div>
    </div>
  );
}
