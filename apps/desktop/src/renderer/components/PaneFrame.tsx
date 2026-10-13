import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Direction, DropTarget, PaneKind, WbPane } from '../layout.js';
import { CheckIcon, CloseIcon, TrashIcon, MinimizeIcon } from '../icons.js';
import { useStore } from '../store.js';
import { ContextAction, ContextMenu } from './ContextMenu.js';
import { confirmDeletion } from './DeleteConfirmation.js';
import { focusWindow, registerWindow, WINDOW_HOTKEYS } from '../window-shortcuts.js';
import { SplitCompass } from './SplitCompass.js';

/**
 * The chrome around one window in a workspace: a thin title strip that is also
 * the handle you drag it by, the compass that adds a window beside it, and a
 * lifecycle button (Complete by default for chats, Close for other windows).
 *
 * While any window is being dragged every window covers itself with a target
 * that reads the pointer's nearest edge, because the thing you drop onto is
 * usually a browser or a terminal that would otherwise swallow the drag before
 * this frame ever saw it.
 */

/** The private drag type, so a pane drag can't be confused with a file drop. */
export const PANE_DRAG_TYPE = 'application/x-nekko-pane';

/**
 * The slot in a window's title strip that its contents may put actions in.
 *
 * A pane used to draw its own header under this one, so a chat showed its title
 * twice: once in the strip you drag the window by and again immediately below.
 * There is one bar now, and a pane contributes to it rather than competing with
 * it. Null outside a frame, so a pane rendered anywhere else keeps whatever
 * chrome it draws for itself.
 */
const PaneChrome = createContext<HTMLElement | typeof SLOT_PENDING | null>(null);
const MetadataChrome = createContext<HTMLElement | null>(null);

export function PaneMetadata({ children }: { children: React.ReactNode }) {
  const slot = useContext(MetadataChrome);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Inside a frame whose strip has not mounted yet (its first render). A pane
 * then knows it is framed and draws no header of its own, instead of drawing
 * one for a single render only to swap it for the portal on the next.
 */
const SLOT_PENDING = Symbol('pane-slot-pending');

/**
 * Render into the window's title strip.
 *
 * A portal rather than a prop because the actions belong to the pane's own state
 * (what it has open, what it is running), and threading that up through the
 * frame would put every pane kind's concerns in the frame's signature.
 */
export function PaneActions({ children }: { children: React.ReactNode }) {
  const slot = useContext(PaneChrome);
  if (!slot || slot === SLOT_PENDING) return null;
  return createPortal(children, slot);
}

/** Whether this pane is inside a frame that offers a title strip to share. */
export function useInPaneFrame(): boolean {
  return useContext(PaneChrome) !== null;
}

/**
 * How far into the window the middle counts as the middle.
 *
 * A point inside this share of both axes offers a swap rather than an edge.
 * Generous on purpose: aiming at the middle of a window is a gesture people make
 * roughly, and an edge is still easy to hit because every edge is only a short
 * move away from it.
 */
const SWAP_ZONE = 0.34;

/**
 * What a drop at this point would do: split along the nearest edge, or, in the
 * middle of the window, trade the two windows' places.
 */
export function targetAt(rect: DOMRect, x: number, y: number): DropTarget {
  const nx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const ny = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const toVertical = Math.min(nx, 1 - nx);
  const toHorizontal = Math.min(ny, 1 - ny);
  if (toVertical > SWAP_ZONE / 2 && toHorizontal > SWAP_ZONE / 2) return 'swap';
  if (toVertical < toHorizontal) return nx < 0.5 ? 'left' : 'right';
  return ny < 0.5 ? 'up' : 'down';
}

/** The band a drop on that edge would fill, as a third of the window. */
const BAND: Record<Direction, React.CSSProperties> = {
  up: { top: 0, left: 0, right: 0, height: '35%' },
  down: { bottom: 0, left: 0, right: 0, height: '35%' },
  left: { left: 0, top: 0, bottom: 0, width: '35%' },
  right: { right: 0, top: 0, bottom: 0, width: '35%' },
};

/**
 * How the window being dropped onto gets out of the way.
 *
 * The band alone says where the new window goes; this says what happens to the
 * one already there, which is the half people were missing. It slides and
 * shrinks away from the edge the drop is aimed at, so the band it leaves behind
 * is visibly empty space rather than a translucent rectangle laid over a window
 * that has not reacted.
 */
const MAKE_WAY: Record<DropTarget, string> = {
  up: 'translateY(9%) scale(0.88)',
  down: 'translateY(-9%) scale(0.88)',
  left: 'translateX(9%) scale(0.88)',
  right: 'translateX(-9%) scale(0.88)',
  // A swap moves nothing aside: both windows keep their slot, so the honest
  // preview is a small recoil rather than room being made.
  swap: 'scale(0.94)',
};

export function PaneFrame({
  pane,
  title,
  icon,
  statusIndicator,
  badge,
  isActive,
  dragging,
  canSplit,
  onSplit,
  onAddWindow,
  onClose,
  onMinimize,
  onFocus,
  onDragStart,
  onDragEnd,
  onDrop,
  ringColor,
  stripStyle,
  addable,
  closeTitle = 'Close this window',
  hideSplit = false,
  locked = false,
  children,
}: {
  pane: WbPane;
  title: string;
  icon: React.ReactNode;
  statusIndicator?: React.ReactNode;
  /** Optional trailing chip (the project a chat belongs to, a status dot). */
  badge?: React.ReactNode;
  isActive: boolean;
  /** The outline, when a surface wants to say more than active or not (a window waiting on you). */
  ringColor?: string;
  /** A tint for the title strip, same reason. */
  stripStyle?: React.CSSProperties;
  /** The kinds the compass offers; the workspace set when omitted. */
  addable?: PaneKind[];
  /** What the close button says it does: a workspace closes a window, the wall only takes it off. */
  closeTitle?: string;
  hideSplit?: boolean;
  locked?: boolean;
  /** The window currently being dragged anywhere in this workspace, if any. */
  dragging: string | null;
  canSplit: (dir: Direction) => boolean;
  onSplit: (dir: Direction, kind: WbPane['kind']) => void;
  onAddWindow?: () => void;
  onClose: () => void;
  /** Remove only the wall window, without completing or deleting its chat. */
  onMinimize?: () => void;
  onFocus: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (target: DropTarget) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const chatPaneAction = useStore((s) => s.settings?.chatPaneAction ?? 'complete');
  const archiveChat = useStore((s) => s.archiveChat);
  const deleteChatForever = useStore((s) => s.deleteChatForever);
  const isChat = pane.kind === 'chat' && !!pane.refId;
  const action = isChat ? chatPaneAction : 'close';
  const complete = () => { void archiveChat(pane.refId); };
  const deleteChat = () => { void deleteChatForever(pane.refId); };
  const deleteWindow = async () => {
    if (isChat) return deleteChat();
    if (pane.kind !== 'terminal' || !await confirmDeletion('Close this terminal? Its running process will be stopped. There is no terminal archive.')) return;
    try {
      await window.nekko.closeTerminal(pane.refId);
      onClose();
      await useStore.getState().refreshTerminals();
    } catch (error) { useStore.getState().pushToast('error', 'Could not close terminal: ' + String(error)); }
  };
  const element = useRef<HTMLDivElement>(null);
  const actions = useRef({ complete, deleteWindow, onMinimize, isChat });
  actions.current = { complete, deleteWindow, onMinimize, isChat };
  useEffect(() => element.current ? registerWindow(pane.id, element.current, (action) => {
    if (action === 'complete' && actions.current.isChat) actions.current.complete();
    if (action === 'minimize') actions.current.onMinimize?.();
    if (action === 'delete') void actions.current.deleteWindow();
  }) : undefined, [pane.id]);
  // Set once the strip is on screen, which is what lets the portal find it.
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [metadataSlot, setMetadataSlot] = useState<HTMLElement | null>(null);
  // A window can't be dropped on itself, so it shows no target for its own drag.
  const targeting = !locked && dragging !== null && dragging !== pane.id;

  return (
    <div
      className="panel panel-ring flex flex-1 flex-col"
      // The ring is a pseudo-element over the contents rather than an inset
      // shadow under them, so the title strip's own background can't paint over
      // the stretch of outline that traces the window's top corners.
      //
      // The active window's ring is the accent mixed down toward the line
      // rather than the accent itself: a full-strength accent traced around the
      // whole pane read as a bright border framing the history. The mix still
      // says "this one" and still follows the user's accent, just quieter.
      style={{
        '--panel-ring-width': locked ? '2px' : '1px',
        '--panel-ring-color': ringColor ?? (isActive
          ? 'color-mix(in srgb, var(--accent) 40%, var(--line))'
          : 'var(--line)'),
      } as React.CSSProperties}
      ref={element}
      data-shortcut-pane={pane.id}
      onFocusCapture={() => focusWindow(pane.id)}
      onMouseDown={() => { focusWindow(pane.id); onFocus(); }}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1"
        style={{ background: isActive ? 'var(--surface-2)' : 'transparent', cursor: 'grab', ...stripStyle }}
        draggable={!locked}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANE_DRAG_TYPE, pane.id);
          // Some targets only see text/plain; harmless duplicate.
          e.dataTransfer.setData('text/plain', pane.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title="Drag to move this window"
      >
        {icon}
        {statusIndicator}
        <span className="min-w-0 max-w-[35%] truncate text-[12px]" style={{ fontWeight: isActive ? 500 : 400 }}>
          {title}
        </span>
        {/* The "/" leads the window's location: the project it belongs to, the
            git branch it is on. It hides when neither has anything to say, and
            it sits between the name and that context, never trailing after. */}
        <span aria-hidden="true" className="pane-strip-sep text-[14px] text-ink-faint opacity-40">/</span>
        <span className="pane-strip-badge flex min-w-0 items-center gap-1 overflow-hidden">{badge}</span>
        <div ref={setMetadataSlot} className="pane-strip-meta flex min-w-0 items-center gap-1 overflow-hidden" />
        <div className="min-w-0 flex-1" />
        {/* The pane's own actions, portalled in, so there is one bar per window
            rather than the frame's and the pane's stacked on each other. */}
        <div ref={setActionSlot} className="flex shrink-0 items-center gap-0.5" />
        {!hideSplit && <SplitCompass kind={pane.kind} canSplit={canSplit} onSplit={onSplit} onOpen={onAddWindow} addable={addable} />}
        {onMinimize && <button
          type="button"
          className="rounded-sm p-1 text-ink-faint hover:text-ink"
          title={`Minimize this window (keep item in Agent panel) (${WINDOW_HOTKEYS.minimize})`}
          aria-label={`Minimize ${title}`}
          onClick={onMinimize}
        >
          <MinimizeIcon className="h-3 w-3" />
        </button>}
        <button
          className="rounded-sm p-1 text-ink-faint hover:text-ink"
          title={action === 'complete' ? `Complete this chat (${WINDOW_HOTKEYS.complete})` : action === 'delete' ? `Delete this chat forever (${WINDOW_HOTKEYS.delete})` : pane.kind === 'terminal' ? `Close terminal (${WINDOW_HOTKEYS.delete})` : closeTitle}
          aria-label={`${action === 'complete' ? 'Complete' : action === 'delete' ? 'Delete' : 'Close'} ${title}`}
          onClick={action === 'complete' ? complete : action === 'delete' || pane.kind === 'terminal' ? deleteWindow : onClose}
        >
          {action === 'complete' ? <CheckIcon className="h-3 w-3" /> : action === 'delete' ? <TrashIcon className="h-3 w-3" /> : <CloseIcon className="h-3 w-3" />}
        </button>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {isChat && <ContextAction onClick={() => { setMenu(null); complete(); }}>Complete ({WINDOW_HOTKEYS.complete})</ContextAction>}
          {isChat && <ContextAction onClick={() => { setMenu(null); void deleteWindow(); }}>Delete ({WINDOW_HOTKEYS.delete})</ContextAction>}
          {onMinimize && <ContextAction onClick={() => { setMenu(null); onMinimize(); }}>Minimize ({WINDOW_HOTKEYS.minimize})</ContextAction>}
          <ContextAction onClick={() => { setMenu(null); if (pane.kind === 'terminal') void deleteWindow(); else onClose(); }}>{pane.kind === 'terminal' ? `Close (${WINDOW_HOTKEYS.delete})` : 'Close'}</ContextAction>
        </ContextMenu>
      )}

      <div className="relative min-h-0 flex-1">
        {/* The body gets out of the way of an incoming drop rather than just
            being covered by a translucent band. */}
        <div
          className="pane-body absolute inset-0"
          style={over ? { transform: MAKE_WAY[over], opacity: 0.55 } : undefined}
        >
          <PaneChrome.Provider value={actionSlot ?? SLOT_PENDING}><MetadataChrome.Provider value={metadataSlot}>{children}</MetadataChrome.Provider></PaneChrome.Provider>
        </div>
        {targeting && (
          <div
            className="absolute inset-0 z-20"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const next = targetAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              if (next !== over) setOver(next);
            }}
            /**
             * Only when the pointer has actually left this window.
             *
             * `dragleave` also fires when the pointer crosses onto a child, so
             * clearing unconditionally made the highlight unmount the moment it
             * appeared, which re-fired `dragover`, which drew it again: the band
             * strobed on every pixel of movement. The children below are
             * `pointer-events: none` so they cannot be crossed onto at all, and
             * this check covers the rest.
             */
            onDragLeave={(e) => {
              const to = e.relatedTarget as Node | null;
              if (!to || !e.currentTarget.contains(to)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const target = targetAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              setOver(null);
              onDrop(target);
            }}
          >
            {over === 'swap' ? (
              <span aria-hidden className="pane-dropzone pane-dropzone-live pane-dropzone-swap">
                <SwapIcon className="h-4 w-4" />
                Swap
              </span>
            ) : over ? (
              <span aria-hidden className="pane-dropzone pane-dropzone-live" style={BAND[over]} />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** Two arrows trading places. The icon set has no swap glyph. */
function SwapIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 8h13l-3.5-3.5" />
      <path d="M20 16H7l3.5 3.5" />
    </svg>
  );
}

/**
 * The frame's two slots, for a frame that is not `PaneFrame`: the Command
 * Center's grid cells draw their own strip and hand its action and metadata
 * areas to the pane inside, so a chat there shows the same controls it shows
 * in the Agent tab rather than falling back to its unframed header. Until the
 * strip is on screen the action slot is pending, as in `PaneFrame`.
 */
export function PaneSlots({ actions, metadata, children }: { actions: HTMLElement | null; metadata: HTMLElement | null; children: React.ReactNode }) {
  return (
    <PaneChrome.Provider value={actions ?? SLOT_PENDING}>
      <MetadataChrome.Provider value={metadata}>{children}</MetadataChrome.Provider>
    </PaneChrome.Provider>
  );
}
