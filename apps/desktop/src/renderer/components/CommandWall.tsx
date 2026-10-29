import { terminalExcerpt } from './terminalExcerpt.js';
import { HOME, applyWallDrop, heldSize, sameTarget, wallDropTargetAt, type Rect, type WallDropTarget } from '../wallDrag.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PendingInput, SessionSummary, TerminalInfo, WorkspaceFolder } from '@nekko-agent/shared';
import { BLOCKED_META, LANE_META, sessionLane } from '@nekko-agent/shared';
import {
  allPanes,
  canSplit,
  isSplit,
  removePane,
  resizeSplit,
  splitPane,
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
  addZone,
  clearZone,
  evenTree,
  fillZone,
  openWallPane,
  filterTree,
  leafRects,
  snapFraction,
  splitBoundary,
  wallAgents,
  wallArrangement,
  nextZoneName,
  wallPane,
  type CommandWallState,
  type ZoneSpot,
} from '../commandWall.js';
import { AGENT_DRAG_TYPE, isAgentDrag, useAgentDrag, type AgentDrag } from '../agentDrag.js';
import { ContextAction, ContextMenu } from './ContextMenu.js';
import { useStore, type Workspace } from '../store.js';
import { foldWindow, growWindow, mostOverlapping, outerSide, type Box } from '../wallMotion.js';
import { ChatPane } from './ChatPane.js';
import { FilePane } from './FilePane.js';
import { ExplorerPane } from './ExplorerPane.js';
import { WorkingSubagents } from './WorkingSubagents.js';
import { NumberedAgentIcon } from './NumberedChatIcon.js';
import { TargetIcon } from '../icons.js';
import { agentStatusOfLane, type AgentStatus } from './WorkspaceCard.js';
import { WallMascot } from './WallMascot.js';
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
import { WallEmptyIllustration, ZoneEmptyIllustration } from './WallEmptyIllustration.js';
import { CREATE_OPTIONS } from './CreateMenu.js';
import type { AgentWindowSelection } from './AgentWindowPicker.js';
import { AgentLogsDrawer } from './AgentLogsDrawer.js';
import { layoutWithLogsDrawer, overlayLogsDrawer, useWallLogs } from '../wallLogs.js';
import { BoltIcon, ChatIcon, CloseIcon, ExternalIcon, LayoutIcon, PlusIcon, TerminalIcon } from '../icons.js';
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
  const filtered = filterTree(state.root, state.filter);
  // Focus shows agents, never an empty zone.
  const tree = state.layout.mode === 'focus' ? allPanes(filtered).filter((p) => p.kind === 'zone').reduce<WbNode | null>((t, p) => removePane(t, p.id), filtered) : filtered;
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
  const addGrid = companionTree(preview && wallArrangement(state.layout) === 'grid' ? addPane(grid, previewPane, width / Math.max(1, stageHeight)) : grid, expanded);
  // Use the measured space remaining beside/above the composer, not a
  // width-derived aspect floor that makes wide windows overflow the viewport.
  let contentHeight = stageHeight;
  if (state.layout.mode === 'focus') {
    if (hero) panes.set(hero, { x: 0, y: 0, width, height: stageHeight });
  } else if (wallArrangement(state.layout) === 'fixed' || width < NARROW_WIDTH) {
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

/** Stable keyed windows across layouts keep transcripts, terminals and drafts warm. */
/** A terminal's state as the wall mascot shows it: an open shell sleeps, an exit is done or failed. */
export function terminalStatus(terminal: Pick<TerminalInfo, 'running' | 'exitCode'>): AgentStatus {
  if (terminal.running) return 'idle';
  return terminal.exitCode ? 'error' : 'done';
}

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
  /** Start a chat (an image chat when asked); resolves to its id once the session list knows it. */
  onNewChat: (selection?: AgentWindowSelection) => Promise<string>;
  onNewTerminal: () => Promise<string>;
  onAddWindow: () => void;
  addContent?: React.ReactNode;
}) {
  const workspaces = useStore((s) => s.workspaces);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The window picked up off the board, and where it would land right now.
  const [lift, setLift] = useState<{ paneId: string; target: WallDropTarget } | null>(null);
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
  // While a window is held the wall lays out as if it had been dropped, so the
  // others step aside and the held window's own box is the landing zone.
  const view = useMemo(() => {
    if (!lift) return state;
    const root = applyWallDrop(state.root, lift.paneId, lift.target);
    return root && root !== state.root ? { ...state, root } : state;
  }, [state, lift]);
  const { geometry, expanded } = useMemo(() => {
    const state = view;
    const base = commandWallGeometry(state, size.width, size.height, new Set(), !!addContent);
    if (wallArrangement(state.layout) !== 'grid') return { geometry: base, expanded: new Set<string>() };
    const expanded = new Set(wallAgents(state.root).filter(p => workspaceCompanions(workspaces, p.refId).length > 0 && !(state.folded[p.refId] ?? (numberOf.size > 4 || (base.panes.get(p.id)?.width ?? 0) < 700))).map(p => p.id));
    return { geometry: expanded.size ? commandWallGeometry(state, size.width, size.height, expanded, !!addContent) : base, expanded };
  }, [view, workspaces, numberOf, size, !!addContent]);
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
      if (count > previous && wallArrangement(state.layout) === 'grid' && (geometry.panes.get(pane.id)?.width ?? 0) < 700) setCompanionNotice(pane);
      seenCompanions.current.set(pane.refId, count);
    }
  }, [workspaces, state.root, wallArrangement(state.layout), geometry, size.width]);
  /**
   * Pick a window up by its title strip. Nothing moves yet: the window's own
   * spot turns into the landing zone and a small card lifts into the hand.
   * Targets are read against the layout as it is now (`rects`), never the
   * previewed one, so a zone opening can't pull the target out from under
   * the pointer.
   */
  const held = useRef<{ paneId: string; rects: Map<string, Rect>; grab: { x: number; y: number }; target: WallDropTarget; grid: boolean; stage: { width: number; height: number }; at?: { x: number; y: number } } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [heldCard, setHeldCard] = useState<{ title: string; kind: PaneKind; from: DOMRect; card: { width: number; height: number }; at: { x: number; y: number } } | null>(null);
  const pickUp = (e: React.PointerEvent, pane: WbPane, title: string) => {
    const win = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-wall-pane]');
    if (!win || held.current) return;
    const from = win.getBoundingClientRect();
    const card = heldSize(from.width, from.height);
    const k = card.width / (from.width || 1);
    held.current = {
      paneId: pane.id, rects: new Map(shownPanes), grab: { x: (e.clientX - from.left) * k, y: (e.clientY - from.top) * k }, target: HOME,
      // A one-column wall is a list, not a tree: it swaps like the fixed grid.
      grid: wallArrangement(state.layout) === 'grid' && size.width >= NARROW_WIDTH,
      stage: { width: size.width, height: geometry.stageHeight },
    };
    setHeldCard({ title, kind: pane.kind, from, card, at: { x: e.clientX, y: e.clientY } });
    setLift({ paneId: pane.id, target: HOME });
  };
  // The card leaves from the window's own rectangle and settles, smaller, under the pointer.
  useLayoutEffect(() => {
    const el = cardRef.current;
    const h = held.current;
    if (!el || !heldCard || !h) return;
    const { from, card, at } = heldCard;
    Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    el.getBoundingClientRect();
    el.dataset.picking = '';
    Object.assign(el.style, { left: `${at.x - h.grab.x}px`, top: `${at.y - h.grab.y}px`, width: `${card.width}px`, height: `${card.height}px` });
    const settled = setTimeout(() => { delete el.dataset.picking; }, 220);
    return () => clearTimeout(settled);
  }, [heldCard]);
  useEffect(() => {
    if (!lift) return;
    const aim = (x: number, y: number, span: boolean) => {
      const h = held.current;
      const stage = pushStageRef.current;
      if (!h || !stage) return;
      h.at = { x, y };
      const o = stage.getBoundingClientRect();
      // Shift at a board edge spans the whole side instead of fitting the row there.
      const target = wallDropTargetAt(h.rects, h.paneId, x - o.left, y - o.top, h.stage, h.grid, 8, span);
      if (sameTarget(target, h.target)) return;
      h.target = target;
      setLift({ paneId: h.paneId, target });
    };
    const move = (ev: PointerEvent) => {
      const h = held.current;
      if (!h) return;
      // Straight to the element: a React render per pointer move would re-run the whole wall.
      const card = cardRef.current;
      if (card) { card.style.left = `${ev.clientX - h.grab.x}px`; card.style.top = `${ev.clientY - h.grab.y}px`; }
      aim(ev.clientX, ev.clientY, ev.shiftKey);
    };
    const shift = (ev: KeyboardEvent) => { const at = held.current?.at; if (ev.key === 'Shift' && at) aim(at.x, at.y, ev.type === 'keydown'); };
    const end = (commit: boolean) => {
      const h = held.current;
      held.current = null;
      if (h && commit && h.target.kind !== 'home') live.current.update((root) => applyWallDrop(root, h.paneId, h.target));
      setLift(null);
      setHeldCard(null);
    };
    const drop = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } else shift(ev); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', shift, true);
    return () => {
      window.removeEventListener('keyup', shift, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
    };
  }, [!!lift]);

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
  const addWindow = async (kind: PaneKind, at?: { paneId: string; dir: Direction }, zoneId?: string, image = false) => {
    let refId: string = kind;
    if (kind === 'chat') refId = await onNewChat(image ? { kind: 'chat', chatType: 'image' } : undefined);
    else if (kind === 'terminal') refId = await onNewTerminal();
    // A side pointed at makes a new zone there; otherwise the window fills a zone.
    setState((s) => at && allPanes(s.root).some((p) => p.id === at.paneId) && canSplit(s.root, at.paneId, at.dir)
      ? { ...s, root: splitPane(s.root, at.paneId, at.dir, { ...wallPane(kind, refId), zone: nextZoneName(s.root) }) }
      : openWallPane(zoneId ? { ...s, activeZone: zoneId } : s, kind, refId));
    // A chat just made is the one you mean to talk to next.
    if (kind === 'chat') onSelect(refId);
  };

  // Clicking a zone, or anything in it, makes it the active zone.
  const activate = (paneId: string) => setState((s) => (s.activeZone === paneId ? s : { ...s, activeZone: paneId }));
  const [zoneMenu, setZoneMenu] = useState<{ x: number; y: number; paneId: string } | null>(null);

  /*
   * An agent row dragged in from the panel. Its chip follows the pointer;
   * dropped on a zone it flies there and grows to the window, and only then
   * does the zone take the agent, so the window appears under the chip.
   */
  const agentDrag = useAgentDrag((s) => s.drag);
  const [landing, setLanding] = useState<AgentDrag | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const chip = landing ?? agentDrag;
  const chipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = chipRef.current;
    if (!el || !chip || landing) return;
    el.replaceChildren(chip.ghost);
    Object.assign(el.style, { left: `${chip.from.left}px`, top: `${chip.from.top}px`, width: `${chip.from.width}px`, height: `${chip.from.height}px` });
  }, [chip?.ghost]);
  useEffect(() => {
    if (!agentDrag) { setDropZone(null); return; }
    const over = (e: DragEvent) => {
      const el = chipRef.current;
      if (el && !el.dataset.landing && (e.clientX || e.clientY)) { el.style.left = `${e.clientX - agentDrag.grab.x}px`; el.style.top = `${e.clientY - agentDrag.grab.y}px`; }
    };
    document.addEventListener('dragover', over);
    return () => document.removeEventListener('dragover', over);
  }, [agentDrag]);
  const dropAgent = (e: React.DragEvent<HTMLElement>, paneId: string) => {
    const d = useAgentDrag.getState().drag;
    if (!d || !isAgentDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropZone(null);
    const commit = () => {
      setState((s) => ({ ...s, root: fillZone(s.root, paneId, d.kind, d.id), activeZone: paneId }));
      if (d.kind === 'chat') onSelect(d.id);
    };
    const el = chipRef.current;
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { commit(); return; }
    const to = e.currentTarget.getBoundingClientRect();
    setLanding(d);
    el.dataset.landing = '';
    Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    setTimeout(() => {
      commit();
      el.dataset.landed = '';
      setTimeout(() => { delete el.dataset.landing; delete el.dataset.landed; setLanding(null); }, 180);
    }, 320);
  };

  // The thin plus buttons along the right and bottom edges, and the zone a hovered one would add.
  const [railPreview, setRailPreview] = useState<ZoneSpot | null>(null);
  const addZoneAt = (spot: ZoneSpot) => setState((s) => {
    const { root, id } = addZone(s.root, spot);
    return id ? { ...s, root, activeZone: id } : s;
  });

  // What the windows' handlers need, read when they run: a window that skipped
  // a render (WallLeaf) still acts on the current wall.
  const live = useRef({ state, aspect, setState, update, onSelect, onOpenChat, onOpenTerminal, focusWindow, addWindow, activate, dropAgent });
  live.current = { state, aspect, setState, update, onSelect, onOpenChat, onOpenTerminal, focusWindow, addWindow, activate, dropAgent };
  // The Focus heroes seen last keep their composer while parked, so going back
  // to one is a visibility flip; the rest park as transcripts.
  const warm = useRef<readonly string[]>([]);
  if (state.layout.mode === 'focus' && state.hero) warm.current = warmFront(warm.current, state.hero);
  // A pane added after the first render is new: in Focus it fades in as the
  // hero. Panes present at mount (a restored wall) never animate.
  const seenPanes = useRef<Set<string> | null>(null);
  const enteringPane = useRef<string | null>(null);
  // The hero it replaces collapses onto the new composer and dissolves into it.
  const leavingPane = useRef<string | null>(null);
  const leavingFor = useRef<string | null>(null);
  const lastFocusHero = useRef<string | null>(null);
  {
    const ids = allPanes(state.root).map((p) => p.id);
    if (state.layout.mode !== 'focus') enteringPane.current = leavingPane.current = null;
    else if (seenPanes.current) for (const id of ids) if (!seenPanes.current.has(id)) {
      enteringPane.current = id;
      leavingFor.current = id;
      leavingPane.current = lastFocusHero.current && lastFocusHero.current !== id && ids.includes(lastFocusHero.current) ? lastFocusHero.current : null;
    }
    seenPanes.current = new Set(ids);
  }
  // Aim the collapse at the new window's composer (both windows share the hero box).
  const aimedLeaving = useRef<string | null>(null);
  // Re-renders the parked window once its collapse ends, so it stops being drawn.
  const [, setLeft] = useState(0);
  useLayoutEffect(() => {
    const leaving = leavingPane.current;
    if (!leaving || aimedLeaving.current === leaving) return;
    aimedLeaving.current = leaving;
    const from = document.querySelector<HTMLElement>(`[data-wall-pane="${CSS.escape(leaving)}"]`);
    const composer = document.querySelector<HTMLElement>(`[data-wall-pane="${CSS.escape(enteringPane.current ?? '')}"] .composer`);
    if (!from || !composer) return; // the CSS fallback aims at a centred composer-sized box
    const a = from.getBoundingClientRect(), b = composer.getBoundingClientRect();
    from.style.setProperty('--collapse-inset', `${b.top - a.top}px ${a.right - b.right}px ${a.bottom - b.bottom}px ${b.left - a.left}px`);
  });
  // Leaving Focus, the parked windows jump to their places instead of sliding
  // there from under the hero: a dozen full-size windows animating down at
  // once rastered every one of them whole (hundreds of MB of tiles, kept).
  // Only the hero slides, as it did before windows were parked.
  const prevMode = useRef(wallArrangement(state.layout));
  const leavingFocus = prevMode.current === 'focus' && state.layout.mode !== 'focus';
  const [unparked, setUnparked] = useState<string | null | undefined>(undefined);
  const snapping = leavingFocus || unparked !== undefined;
  const snapHero = leavingFocus ? lastFocusHero.current : unparked;
  if (state.layout.mode === 'focus') lastFocusHero.current = geometry.hero;
  // Switching hero again mid-collapse drops it, so it never replays when parked later.
  if (leavingPane.current && geometry.hero !== leavingFor.current) leavingPane.current = aimedLeaving.current = null;
  useLayoutEffect(() => {
    const left = prevMode.current === 'focus' && state.layout.mode !== 'focus';
    prevMode.current = wallArrangement(state.layout);
    if (!left) return;
    setUnparked(lastFocusHero.current);
    // Two frames: the jump has been styled by then, so turning transitions
    // back on starts none.
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setUnparked(undefined)); });
    return () => { cancelAnimationFrame(id); setUnparked(undefined); };
  }, [wallArrangement(state.layout)]);

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
    lastPush.current = size.width > 0 ? { ids, boxes: new Map(shownPanes), els, mode: wallArrangement(state.layout) } : null;
    if (!before || before.mode !== wallArrangement(state.layout) || state.layout.mode === 'focus' || snapping) return;
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
    if (pane.kind === 'zone') return pane.zone ?? 'Zone';
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
      agentStatus = agentStatusOfLane(lane, blocked, session.activeWatchCount);
      status = needsYou && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone, live: true } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
    } else if (terminal) {
      status = terminal.running ? { label: 'Shell open', tone: 'var(--success)' } : { label: terminal.exitCode ? `Exited with code ${terminal.exitCode}` : 'Exited', tone: 'var(--ink-faint)' };
    }
    const title = titleOf(pane);
    const flashing = flash?.paneId === pane.id;
    const openable = pane.kind === 'chat' || pane.kind === 'terminal';
    const selected = pane.kind === 'chat' && pane.refId === selectedId;
    const n = pane.kind === 'chat' ? numberOf.get(pane.refId) : undefined;

    const rect = shownPanes.get(pane.id);
    const hero = geometry.hero === pane.id;
    const focusedChat = pane.kind === 'chat' && state.layout.mode === 'focus' && hero;
    const folded = state.folded[pane.refId] ?? (!focusedChat && (numberOf.size > 4 || (wallArrangement(state.layout) === 'grid' && (rect?.width ?? 0) < 700)));
    const showCompanions = focusedChat ? !(state.folded[pane.refId] ?? false) : !folded && wallArrangement(state.layout) === 'grid';
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
    // Every window outside Focus has its own composer. In Focus a recent hero
    // keeps its composer while parked; the others park as transcripts.
    const tiled = state.layout.mode !== 'focus';
    const fullSurface = tiled || focusedChat || (parked && warm.current.includes(pane.refId));
    // Parked at the hero's size, so at its density too: nothing in the window changes when it comes back.
    const density = densityOf(parked && geometry.hero ? geometry.hero : pane.id);
    const logsOpen = logsPane?.id === pane.id && !logsClosing && !logsOverlay;
    const subagents = session ? childrenOf.get(session.id) : undefined;
    const snap = snapping && pane.id !== snapHero;
    const entering = enteringPane.current === pane.id;
    const lifted = lift?.paneId === pane.id;
    const pickable = !!box && !parked && !inDeck && state.layout.mode !== 'focus';
    const leaving = leavingPane.current === pane.id && parked;
    const zoned = state.layout.mode !== 'focus';
    const activeZone = zoned && state.activeZone === pane.id;
    const dropping = dropZone === pane.id;
    const deps = [
      zoned, activeZone, dropping, zoneMenu?.paneId === pane.id,
      entering, leaving,
      pane, title, session, terminal, project?.name, projects.length > 1, status?.label, status?.live, needsYou, agentStatus,
      flashing, selected, n, box?.x, box?.y, box?.width, box?.height, parked, hero, focusedChat, folded, showCompanions,
      inDeck, fullSurface, density, logsOpen, snap, workspaces, lifted, pickable, wallArrangement(state.layout), state.root, subagents, running, pending,
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
        data-wall-entering={(entering && state.layout.mode === 'focus' && hero) || undefined}
        data-wall-leaving={leaving || undefined}
        onAnimationEnd={entering || leaving ? (e) => {
          if (e.animationName === 'focus-new-agent-in' && enteringPane.current === pane.id) enteringPane.current = null;
          if (e.animationName === 'focus-collapse-into-composer' && leavingPane.current === pane.id) { leavingPane.current = aimedLeaving.current = null; e.currentTarget.style.removeProperty('--collapse-inset'); setLeft((n) => n + 1); }
        } : undefined}
        data-wall-pane={pane.id}
        data-grid-cell={`${pane.kind}:${pane.refId}`}
        data-wall-selected={selected || undefined}
        data-wall-lifted={lifted || undefined}
        data-wall-working={agentStatus === 'working' || undefined}
        data-wall-needs-you={needsYou || undefined}
        data-wall-logs-open={logsOpen || undefined}
        data-zone={zoned ? pane.zone ?? '' : undefined}
        data-zone-active={activeZone || undefined}
        data-zone-drop={dropping || undefined}
        onPointerDownCapture={zoned ? () => live.current.activate(pane.id) : undefined}
        // Capture: a composer inside would otherwise take the drop as a file.
        onDragOverCapture={zoned ? (e) => { if (!isAgentDrag(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropZone(pane.id); } : undefined}
        onDropCapture={zoned ? (e) => live.current.dropAgent(e, pane.id) : undefined}
      >
        {zoned && <div className="wall-zone-header" title="Drag to move this zone. Right-click to close it."
          onPointerDown={pickable ? (e) => { if (e.button === 0) pickUp(e, pane, title); } : undefined}
          onContextMenu={(e) => { e.preventDefault(); setZoneMenu({ x: e.clientX, y: e.clientY, paneId: pane.id }); }}>
          <span>{pane.zone ?? 'Zone'}</span>
        </div>}
        {pane.kind === 'zone' ? <div className="wall-zone-empty" data-zone-empty>
          <ZoneEmptyIllustration />
          <p className="wall-zone-empty-title">Empty zone</p>
          <p>Drag in an agent chat or start a new one below.</p>
          <div className="wall-zone-create">
            {CREATE_OPTIONS.map(([kind, label, icon, shortcut]) => <button key={kind} type="button" className={`btn btn-ghost wall-zone-option${kind === 'chat' ? ' text-accent' : ''}`} data-zone-create={kind} aria-label={label} title={`${label} (${shortcut.label})`}
              onClick={() => { void live.current.addWindow(kind === 'terminal' ? 'terminal' : 'chat', undefined, pane.id, kind === 'image'); }}><PlusIcon className="wall-zone-plus h-3.5 w-3.5" />{icon}<span className="wall-zone-label">{label}</span><kbd className="kbd wall-zone-kbd">{shortcut.label}</kbd></button>)}
          </div>
        </div> : <>
        {/* The composer's beam, quieter: a working agent window says so at a glance. */}
        <PaneFrame
          pane={pane}
          title={title}
          // The window's type and number, then Nekko wearing its status badge (terminals too).
          icon={pane.kind === 'chat' ? <><NumberedAgentIcon number={n} /><span data-agent-status><WallMascot status={agentStatus} /></span></>
            : terminal ? <>{iconOf(pane.kind)}<span data-agent-status><WallMascot status={terminalStatus(terminal)} label={status?.label} /></span></> : iconOf(pane.kind)}
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
          closeTitle={pane.kind === 'chat' ? 'Stop agent and watchers, then remove from the wall (chat is kept)' : 'Remove from the wall'}
          onPickUp={pickable ? (e) => pickUp(e, pane, title) : undefined}
          canSplit={(dir) => wallArrangement(state.layout) === 'grid' && !inDeck && canSplit(state.root, pane.id, dir)}
          onAddWindow={() => live.current.setState((s) => s.layout.mode === 'focus' ? { ...s, layout: { ...s.layout, mode: 'grid' } } : s)}
          onSplit={(dir, kind) => { void live.current.addWindow(kind, { paneId: pane.id, dir }); }}
          onClose={() => { void closeWallAgent(pane, () => live.current.update((root) => clearZone(root, pane.id))); }}
          focusAction={openable && <button type="button" className="command-wall-action agent-zen-action" title="Zen: focus this window (Ctrl+Shift+1)" aria-label={`Focus ${title}`} onClick={() => live.current.focusWindow(pane)}><TargetIcon className="h-5 w-5" /></button>}
          onMinimize={() => live.current.update((root) => clearZone(root, pane.id))}
          onFocus={() => { if (pane.kind === 'chat') live.current.onSelect(pane.refId); }}
        >
          {/* What it is waiting on is said inside the window (ChatPane pins the
              question or approval at the top). A banner here sat under the
              absolutely positioned content and could not be seen. */}
          {deckCard && <button className="command-wall-card" onClick={() => live.current.focusWindow(pane)} aria-label={`Focus ${title}`}>{terminal ? <TerminalExcerpt terminalId={terminal.id} /> : <span>{session?.lastReplyText || 'No reply yet'}</span>}<small>{session ? `${session.modelId || 'Default model'} · ${session.transcriptTokens.toLocaleString()} context tokens` : status?.label}</small></button>}
          <div className="command-wall-content" inert={!box || deckCard} aria-hidden={!box || deckCard || undefined} data-companions-visible={showCompanions && companions.length > 0 || undefined} data-focus-chat={(focusedChat || parked) || undefined}>

            <div className="command-wall-primary">
           {pane.kind === 'chat' ? <PaneVisibleContext.Provider value={!parked}><PaneDensityHint.Provider value={density}><ChatPane key={pane.refId} sessionId={pane.refId} commandCenter surface={fullSurface ? 'full' : 'transcript'} cleanStart={focusedChat} status={agentStatus ?? 'idle'} selected={fullSurface ? undefined : selected} resting={tiled && !selected} /></PaneDensityHint.Provider></PaneVisibleContext.Provider>
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
          {session && <WorkingSubagents children={subagents ?? []} running={running} pending={pending} onOpen={(id) => { const { setState, onSelect } = live.current; setState((s) => openWallPane(s, 'chat', id)); onSelect(id); }} />}
        </PaneFrame></>}
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
          <Divider splitId={node.id} index={i - 1} dir={node.dir} snapped={!!state.snap && Math.abs((splitBoundary(companionTree(state.root, expanded), node.id, i - 1) ?? -1) - (splitBoundary(companionTree(evenTree(state.root), expanded), node.id, i - 1) ?? -2)) < 1e-6} onResize={(id, index, value) => update((root) => {
            // Snap to grid: even spacing is a snap point the divider pulls onto when near it.
            const target = state.snap ? splitBoundary(companionTree(evenTree(root), expanded), id, index) : null;
            return resizeCompanionSplit(root, expanded, id, index, snapFraction(value, target));
          })} />
        </div>}
        {renderDividers(child, childRect)}
      </React.Fragment>;
    });
  };

  // The add-zone rails: one plus per zone along the right and bottom edges
  // (fitting that zone's row or column), and one that spans the whole side
  // when that would come out differently.
  const zoneRails = state.layout.mode !== 'focus' && wallArrangement(state.layout) === 'grid' && size.width >= NARROW_WIDTH && !addContent && !!state.root;
  const railSegments = (side: 'right' | 'down') => allPanes(state.root).flatMap((p) => {
    const r = shownPanes.get(p.id);
    if (!r) return [];
    if (side === 'right') return r.x + r.width >= size.width - 8 ? [{ paneId: p.id, from: r.y, len: r.height, full: r.height >= geometry.stageHeight - 8 }] : [];
    return r.y + r.height >= geometry.stageHeight - 8 ? [{ paneId: p.id, from: r.x, len: r.width, full: r.width >= size.width - 8 }] : [];
  });
  const railGhost = useMemo(() => {
    if (!railPreview) return null;
    const { root, id } = addZone(state.root, railPreview);
    return id ? commandWallGeometry({ ...state, root }, size.width, size.height).panes.get(id) ?? null : null;
  }, [railPreview, state, size]);
  const spanWord = (side: Direction) => (side === 'left' || side === 'right' ? { span: 'full height', fit: 'row' } : { span: 'full width', fit: 'column' });
  const heldBox = lift ? shownPanes.get(lift.paneId) : undefined;
  const spanHint = lift && heldBox && (lift.target.kind === 'edge' || (lift.target.kind === 'beside' && lift.target.atEdge))
    ? lift.target.kind === 'edge' ? `Spans the ${spanWord(lift.target.side).span}. Let go of Shift to fit the ${spanWord(lift.target.side).fit}.` : `Hold Shift to span the ${spanWord(lift.target.side).span}`
    : null;

  return (
    <div ref={wrapRef} className="command-wall-layout" data-command-wall="windows" data-wall-layout={wallArrangement(state.layout)} data-wall-lifting={lift ? '' : undefined} data-zone-rails={zoneRails || undefined}>
      {chip && createPortal(<div ref={chipRef} className="wall-agent-chip" aria-hidden />, document.body)}
      {zoneMenu && <ContextMenu x={zoneMenu.x} y={zoneMenu.y} onClose={() => setZoneMenu(null)}>
        <ContextAction disabled={allPanes(state.root).length < 2} onClick={() => {
          const id = zoneMenu.paneId;
          setZoneMenu(null);
          // The agent in it is minimized, not stopped or completed.
          setState((s) => {
            const root = removePane(s.root, id);
            return { ...s, root, activeZone: s.activeZone === id ? allPanes(root)[0]?.id ?? null : s.activeZone };
          });
        }}>Close zone</ContextAction>
      </ContextMenu>}
      {/* The shield keeps a browser or terminal under the pointer from swallowing the drag. */}
      {heldCard && createPortal(<>
        <div className="wall-drag-shield" aria-hidden />
        <div ref={cardRef} className="wall-held-card" aria-hidden><div className="wall-held-card-strip">{iconOf(heldCard.kind)}<span>{heldCard.title}</span></div></div>
      </>, document.body)}
      {companionNotice && <div className="command-wall-notice" role="status">A companion opened in a narrow window. <button onClick={() => { focusWindow(companionNotice); setCompanionNotice(null); }}>Focus {titleOf(companionNotice)}</button><button aria-label="Dismiss companion notice" onClick={() => setCompanionNotice(null)}>×</button></div>}
      <div className="command-wall-stage" data-wall-vacant={!addContent && !state.root || undefined} style={{ height: Math.max(geometry.height, addContent ? geometry.add.y + createHeight + 64 : 0), width: size.width }}>
        <div ref={pushStageRef} className="command-wall-pane-stage" style={{ position: 'absolute', inset: 0, top: 0 }}>
        {/* Closing windows fold away here, under the live ones; React never renders into it. */}
        <div ref={leavingRef} className="command-wall-leaving" aria-hidden />
        {/* Grid's unfilled squares, drawn under the windows as quiet hatching. */}
        {wallArrangement(state.layout) === 'fixed' && geometry.panes.size > 0 && geometry.empty.map((r, i) => (
          <div key={`empty-${i}`} className="command-wall-empty-cell" aria-hidden data-wall-empty-cell style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />
        ))}
        {allPanes(state.root).map(renderLeaf)}
        {logsPane && logsLayout?.drawer && <AgentLogsDrawer key={logsPane.refId} sessionId={logsPane.refId} title={titleOf(logsPane)} rect={logsLayout.drawer} overlay={logsOverlay} selected={logsPane.refId === selectedId} />}
        {!addContent && wallArrangement(state.layout) === 'grid' && size.width >= NARROW_WIDTH && geometry.addGrid && renderDividers(geometry.addGrid)}
        {railGhost && <div className="wall-zone-ghost" aria-hidden style={{ left: railGhost.x, top: railGhost.y, width: railGhost.width, height: railGhost.height }}><span>New zone</span></div>}
        {spanHint && heldBox && <div className="wall-span-hint" role="status" style={{ left: heldBox.x + heldBox.width / 2, top: heldBox.y + heldBox.height / 2 }}>{spanHint}</div>}
        </div>
        {zoneRails && (['right', 'down'] as const).map((side) => {
          const segments = railSegments(side);
          const across = side === 'right';
          const { span, fit } = spanWord(side);
          const preview = (spot: ZoneSpot) => ({ onPointerEnter: () => setRailPreview(spot), onFocus: () => setRailPreview(spot), onPointerLeave: () => setRailPreview(null), onBlur: () => setRailPreview(null) });
          return <div key={side} className="wall-zone-rail" data-side={side} style={across ? { left: size.width, top: 0, height: geometry.stageHeight } : { left: 0, top: geometry.stageHeight, width: size.width }}>
            {segments.map((g) => <button key={g.paneId} type="button" className="wall-zone-add" style={across ? { top: g.from + g.len / 2 } : { left: g.from + g.len / 2 }}
              aria-label={`Add a zone to this ${fit}`} title={`Add a zone to this ${fit} (Shift-click: span the ${span})`}
              {...preview({ paneId: g.paneId, side })}
              onClick={(e) => { addZoneAt(e.shiftKey ? { edge: side } : { paneId: g.paneId, side }); setRailPreview(null); }}><PlusIcon className="h-3.5 w-3.5" /></button>)}
            {segments.some((g) => !g.full) && <button type="button" className="wall-zone-add wall-zone-span" style={across ? { top: geometry.stageHeight - 12 } : { left: size.width - 12 }}
              aria-label={`Add a zone spanning the ${span}`} title={`Add a zone spanning the ${span}`}
              {...preview({ edge: side })}
              onClick={() => { addZoneAt({ edge: side }); setRailPreview(null); }}><SpanIcon className="h-3.5 w-3.5" /></button>}
          </div>;
        })}
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

/** A plus between two end bars: a new zone that runs the whole side. Drawn for the right rail; the bottom rail turns it. */
function SpanIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className} aria-hidden><path d="M7 3h10M7 21h10M12 8v8M8 12h8" /></svg>;
}

/** Closing stops work before removing its view; minimizing only hides it. */
export async function closeWallAgent(pane: WbPane, remove: () => void): Promise<void> {
  try {
    if (pane.kind === 'chat') await window.nekko.abortChat(pane.refId);
    remove();
  } catch (error) {
    useStore.getState().pushToast('error', `Could not stop agent and watchers: ${String(error)}`);
  }
}
