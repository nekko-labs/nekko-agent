import React, { useEffect, useRef } from 'react';
import { TerminalPane } from './TerminalPane.js';
import { DiffPane } from './DiffPane.js';
import { ExplorerPane } from './ExplorerPane.js';
import { BrowserPane } from './BrowserPane.js';
import { CloseIcon, DiffIcon, ExternalIcon, FolderIcon, GlobeIcon, TerminalIcon } from '../icons.js';
import { chatFolderPath, useStore } from '../store.js';
import { useWallLogs, type Rect, type WallDrawerKind } from '../wallLogs.js';

const HEADS: Record<WallDrawerKind, { label: string; Icon: (p: { className?: string }) => React.JSX.Element }> = {
  logs: { label: 'Agent commands', Icon: TerminalIcon },
  diff: { label: 'Changes', Icon: DiffIcon },
  files: { label: 'Files', Icon: FolderIcon },
  browser: { label: 'Browser', Icon: GlobeIcon },
};

/** The drawer's body for one kind. Keyed by kind so switching remounts cleanly. */
function DrawerBody({ sessionId, kind }: { sessionId: string; kind: WallDrawerKind }) {
  const folder = useStore((s) => kind === 'files' ? chatFolderPath(s, sessionId) : '');
  switch (kind) {
    case 'diff': return <DiffPane sessionId={sessionId} />;
    case 'files': return <ExplorerPane paneId={`drawer_${sessionId}`} root={folder} />;
    case 'browser': return <BrowserPane url="about:blank" />;
    default: return <TerminalPane terminalId={`agent_${sessionId}`} />;
  }
}

/**
 * An agent's command log (or its Changes, Files or Browser) on the Agents
 * wall, as a drawer of its own that
 * slides out of its window's right edge. It used to float over the window and
 * cover the transcript; now the wall makes room for it (CommandWall moves the
 * windows to its right) and, closed, it is absorbed back into the window. Its
 * left side has no border and covers the window's edge, so the two read as one.
 */
export function AgentLogsDrawer({ sessionId, title, rect, overlay, selected }: {
  sessionId: string;
  title: string;
  rect: Rect;
  /** A one-column wall: the drawer sits over its window instead of beside it. */
  overlay?: boolean;
  selected?: boolean;
}) {
  const closing = useWallLogs((s) => s.closing);
  const close = useWallLogs((s) => s.close);
  const closed = useWallLogs((s) => s.closed);
  const kind = useWallLogs((s) => s.kind);
  const head = HEADS[kind];
  const ref = useRef<HTMLDivElement>(null);

  // Without motion there is no animationend to wait for.
  useEffect(() => {
    if (closing && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) closed();
  }, [closing, closed]);

  return (
    <div
      ref={ref}
      className="agent-logs-drawer"
      role="dialog"
      aria-label={kind === 'logs' ? `Command log for ${title}` : `${head.label} for ${title}`}
      data-drawer-kind={kind}
      data-agent-logs
      data-closing={closing || undefined}
      data-selected={selected || undefined}
      data-overlay={overlay || undefined}
      style={overlay ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : { left: rect.x - 1, top: rect.y, width: rect.width + 1, height: rect.height }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
      onAnimationEnd={(e) => { if (e.target === ref.current && closing) closed(); }}
    >
      <div className="agent-logs-drawer-inner">
        <header className="agent-logs-drawer-head">
          <head.Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate">{head.label}</span>
          <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title={`Close ${kind === 'logs' ? 'the log' : head.label} (Esc)`} aria-label={kind === 'logs' ? 'Close the command log' : `Close ${head.label}`} onClick={close}><CloseIcon className="h-3 w-3" /></button>
        </header>
        <div className="agent-logs-drawer-body"><DrawerBody key={kind} sessionId={sessionId} kind={kind} /></div>
      </div>
    </div>
  );
}
