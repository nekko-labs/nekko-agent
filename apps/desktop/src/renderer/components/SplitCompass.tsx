import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Direction, PaneKind } from '../layout.js';
import { MAX_ACROSS } from '../layout.js';
import { BoltIcon, ChatIcon, CloseIcon, ExternalIcon, FileIcon, FolderIcon, LayoutIcon, PlusIcon, TerminalIcon } from '../icons.js';

/**
 * Where a new window goes, asked as a picture.
 *
 * A menu of "split right / split down / split left / split up" is four strings
 * you have to read; this is the window you are in, drawn in the middle, with a
 * target on each of its four sides and a line running out to each target. You
 * point at a side, that side lights up and its line starts running, and then
 * you say what should appear there. Directions the 8×8 ceiling has already
 * used up are visibly spent rather than silently doing nothing.
 */

/** Every kind of window a compass may offer; a caller picks the subset its surface can hold. */
const ADDABLE: Array<{ kind: PaneKind; label: string; hint: string; Icon: (p: { className?: string }) => React.JSX.Element }> = [
  { kind: 'chat', label: 'Chat', hint: 'Another agent, working alongside this one', Icon: ChatIcon },
  { kind: 'terminal', label: 'Terminal', hint: 'A shell in this project', Icon: TerminalIcon },
  { kind: 'files', label: 'Files', hint: 'Browse and open files', Icon: FolderIcon },
  { kind: 'browser', label: 'Browser', hint: 'A page, docs, or your running app', Icon: ExternalIcon },
  { kind: 'automations', label: 'Automations', hint: 'Scheduled, recurring and background work', Icon: BoltIcon },
  { kind: 'insights', label: 'Insights', hint: 'Vitals, cost, tokens and optimize tips', Icon: LayoutIcon },
];

/** What the Agent tab's windows offer: the kinds a workspace can hold. */
export const WORKSPACE_ADDABLE: PaneKind[] = ['chat', 'terminal', 'files', 'browser'];

/** Panel width, needed up front to right-align it against the trigger. */
const PANEL_W = 212;

/**
 * The glyph for the window in the middle. Wider than what you can add: a diff,
 * a PR or the Hypergate manager can be split from even though nothing offers to
 * create one here.
 */
const CENTRE_ICON: Record<PaneKind, (p: { className?: string }) => React.JSX.Element> = {
  chat: ChatIcon,
  terminal: TerminalIcon,
  files: FolderIcon,
  file: FileIcon,
  diff: FileIcon,
  pr: FileIcon,
  browser: ExternalIcon,
  hypergate: ExternalIcon,
  automations: BoltIcon,
  insights: LayoutIcon,
  subscriptions: LayoutIcon,
  resources: LayoutIcon,
  zone: LayoutIcon,
};

const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];
const DIR_LABEL: Record<Direction, string> = { up: 'Above', right: 'To the right', down: 'Below', left: 'To the left' };

/** Geometry of one target, as offsets from the centre of the compass. */
const SPOT: Record<Direction, React.CSSProperties> = {
  up: { top: 0, left: '50%', transform: 'translateX(-50%)' },
  down: { bottom: 0, left: '50%', transform: 'translateX(-50%)' },
  left: { left: 0, top: '50%', transform: 'translateY(-50%)' },
  right: { right: 0, top: '50%', transform: 'translateY(-50%)' },
};

/**
 * The run of line between the centre glyph and one target: it starts where the
 * target ends and stops where the centre begins, so nothing overlaps.
 */
const LINE: Record<Direction, React.CSSProperties> = {
  up: { top: 26, bottom: 'auto', height: 22, left: '50%' },
  down: { bottom: 26, top: 'auto', height: 22, left: '50%' },
  left: { left: 30, right: 'auto', width: 35, top: '50%' },
  right: { right: 30, left: 'auto', width: 35, top: '50%' },
};

export function SplitCompass({
  kind,
  canSplit,
  onSplit,
  onOpen,
  addable = WORKSPACE_ADDABLE,
  className = '',
}: {
  /** The window being split, drawn in the middle. */
  kind: PaneKind;
  canSplit: (dir: Direction) => boolean;
  onSplit: (dir: Direction, kind: PaneKind) => void;
  /** Explicit activation may change layout; hover previews never do. */
  onOpen?: () => void;
  /** The kinds this surface can add, in the order to offer them. */
  addable?: PaneKind[];
  className?: string;
}) {
  const offered = addable.map((k) => ADDABLE.find((a) => a.kind === k)).filter((a): a is (typeof ADDABLE)[number] => !!a);
  const [open, setOpen] = useState(false);
  /**
   * Whether a click put it there. Hovering is a preview that goes away when the
   * pointer does; clicking keeps it, which is what lets a pointer wander off to
   * think without losing the panel. Without the distinction, hover opens the
   * panel and the click that follows reads as "close it again".
   */
  const [pinned, setPinned] = useState(false);
  const [dir, setDir] = useState<Direction | null>(null);
  const [hover, setHover] = useState<Direction | null>(null);
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number>(0);

  const close = () => {
    setOpen(false);
    setPinned(false);
    setDir(null);
    setHover(null);
  };

  // Hover opens it, but a pointer that merely crosses the button on its way
  // somewhere else shouldn't leave a panel behind: leaving starts a short
  // grace period instead of closing outright, so the gap between the button
  // and the panel is crossable.
  const enter = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    window.clearTimeout(closeTimer.current);
    if (pinned) return;
    closeTimer.current = window.setTimeout(close, 220);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Every window clips its own content, so the panel is a portal on the body
  // rather than an absolute child that the pane would cut in half. That means
  // positioning it by hand: under the button, right-aligned, nudged back on
  // screen for a window near either edge.
  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.right - PANEL_W), window.innerWidth - PANEL_W - 8);
    setAt({ top: r.bottom + 6, left });
  }, [open, dir]);

  useEffect(() => {
    if (!open) return;
    // The panel is a portal on the body, so "inside" is the trigger or the
    // panel, never the trigger's subtree alone.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !panel.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc steps back to the compass from the type list, then out.
      if (dir) setDir(null);
      else close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, dir]);

  const pick = (d: Direction) => {
    if (!canSplit(d)) return;
    setDir(d);
  };

  return (
    <div className={`relative ${className}`} ref={wrap} onMouseEnter={enter} onMouseLeave={leave}>
      <button
        ref={trigger}
        className={`rounded-sm p-1 ${open ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
        title="Add a window beside this one"
        aria-label="Add a window beside this one"
        aria-expanded={open}
        onClick={() => {
          window.clearTimeout(closeTimer.current);
          setOpen(true);
          setPinned(true);
          onOpen?.();
        }}
        onFocus={enter}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>

      {open && createPortal(
        <div
          ref={panel}
          className="card fixed z-50 p-3 shadow-(--shadow-float)"
          // Opaque, unlike the cards that sit on a page: this one floats over a
          // conversation, and a translucent panel would read the chat's text
          // straight through the compass.
          style={{ top: at.top, left: at.left, width: PANEL_W, background: 'var(--paper)' }}
          role="dialog"
          aria-label="Add a window"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {!dir ? (
            <>
              <p className="mb-1 px-0.5 text-2xs text-ink-faint">Where should it go?</p>
              <Compass kind={kind} hover={hover} canSplit={canSplit} onHover={setHover} onPick={pick} />
              <p className="mt-1 h-4 text-center text-2xs text-ink-faint">
                {hover ? (canSplit(hover) ? DIR_LABEL[hover] : `No room — ${MAX_ACROSS} is the limit`) : ''}
              </p>
            </>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-1 px-0.5">
                <button
                  className="rounded-sm p-0.5 text-ink-faint hover:text-ink"
                  title="Pick a different side"
                  aria-label="Pick a different side"
                  onClick={() => setDir(null)}
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                </button>
                <span className="text-2xs text-ink-faint">{DIR_LABEL[dir]} — what goes there?</span>
              </div>
              {offered.map(({ kind: k, label, hint, Icon }) => (
                <button
                  key={k}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-2"
                  onClick={() => {
                    onSplit(dir, k);
                    close();
                  }}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="block text-2xs leading-tight text-ink-faint">{hint}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The picture itself: centre glyph, four targets, a live line out to each. */
function Compass({
  kind,
  hover,
  canSplit,
  onHover,
  onPick,
}: {
  kind: PaneKind;
  hover: Direction | null;
  canSplit: (dir: Direction) => boolean;
  onHover: (dir: Direction | null) => void;
  onPick: (dir: Direction) => void;
}) {
  const Centre = CENTRE_ICON[kind] ?? ChatIcon;
  return (
    <div className="relative mx-auto h-[140px] w-[190px]" onMouseLeave={() => onHover(null)}>
      {DIRECTIONS.map((d) => {
        const live = hover === d;
        const room = canSplit(d);
        const horizontal = d === 'left' || d === 'right';
        return (
          <React.Fragment key={d}>
            <span
              aria-hidden
              className={`compass-line ${horizontal ? 'compass-line-h' : 'compass-line-v'} ${
                live && room ? 'compass-line-live' : ''
              } ${d === 'left' || d === 'up' ? 'compass-line-reverse' : ''}`}
              style={{
                ...LINE[d],
                color: live && room ? 'var(--accent)' : 'var(--ink-faint)',
                ...(horizontal ? { marginTop: -0.5 } : { marginLeft: -0.5 }),
                opacity: room ? undefined : 0.2,
              }}
            />
            <button
              className="absolute grid place-items-center rounded-lg border transition-[background-color,border-color,color,opacity,transform] duration-150"
              style={{
                ...SPOT[d],
                width: horizontal ? 30 : 44,
                height: horizontal ? 44 : 26,
                borderColor: live && room ? 'var(--accent)' : 'var(--line)',
                background: live && room ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: live && room ? 'var(--accent)' : 'var(--ink-faint)',
                boxShadow: live && room ? '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)' : undefined,
                opacity: room ? 1 : 0.35,
                cursor: room ? 'pointer' : 'not-allowed',
              }}
              title={room ? DIR_LABEL[d] : `No room: an agent holds at most ${MAX_ACROSS} windows across`}
              aria-label={DIR_LABEL[d]}
              aria-disabled={!room}
              onMouseEnter={() => onHover(d)}
              onFocus={() => onHover(d)}
              onClick={() => onPick(d)}
            >
              {room ? <PlusIcon className="h-3.5 w-3.5" /> : <CloseIcon className="h-3 w-3" />}
            </button>
          </React.Fragment>
        );
      })}

      {/* The window you are splitting. */}
      <span
        aria-hidden
        className="absolute left-1/2 top-1/2 grid h-[44px] w-[60px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg border border-line"
        style={{ background: 'var(--paper)', color: 'var(--ink-soft)' }}
      >
        <Centre className="h-4 w-4" />
      </span>
    </div>
  );
}
