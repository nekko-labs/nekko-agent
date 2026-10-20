import React, { useEffect, useState } from 'react';
import type { TerminalViewer, TerminalViewersEvent } from '@nekko-agent/shared';

/**
 * "Phone attached" on a terminal while a paired phone is watching it (IO-33
 * FA-3). The computer's remote layer marks viewers with `terminal:attach`; the
 * list arrives on the terminal's info and changes on `terminal:viewers`.
 */

/** What the badge says, or null when nobody remote is attached. */
export function viewersLabel(viewers: readonly TerminalViewer[]): string | null {
  if (viewers.length === 0) return null;
  if (viewers.length === 1) {
    const [v] = viewers;
    if (v.name) return `${v.name} attached`;
    return v.kind === 'phone' ? 'Phone attached' : 'Remote viewer attached';
  }
  return viewers.every((v) => v.kind === 'phone') ? `${viewers.length} phones attached` : `${viewers.length} remote viewers attached`;
}

/** The viewers after an event: the event's list when it is about this terminal. */
export function applyViewersEvent(terminalId: string, current: TerminalViewer[], e: TerminalViewersEvent): TerminalViewer[] {
  return e.terminalId === terminalId ? e.viewers : current;
}

export function ViewersBadge({ viewers }: { viewers: readonly TerminalViewer[] }) {
  const label = viewersLabel(viewers);
  if (!label) return null;
  const names = viewers.map((v) => v.name ?? (v.kind === 'phone' ? 'A phone' : 'A remote viewer')).join(', ');
  return (
    <span
      role="status"
      title={`Watching this terminal remotely: ${names}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent"
      data-testid="terminal-viewers-badge"
    >
      <svg aria-hidden="true" width="10" height="12" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1" y="1" width="8" height="12" rx="1.6" />
        <path d="M4 10.8h2" strokeLinecap="round" />
      </svg>
      <span className="max-w-[22ch] truncate">{label}</span>
    </span>
  );
}

/** The badge for one terminal, following `terminal:viewers` from where `initial` left off. */
export function TerminalViewersBadge({ terminalId, initial }: { terminalId: string; initial?: TerminalViewer[] }) {
  const [viewers, setViewers] = useState<TerminalViewer[]>(initial ?? []);
  useEffect(() => setViewers(initial ?? []), [initial]);
  useEffect(
    () => window.nekko.onTerminalViewers?.((e) => setViewers((current) => applyViewersEvent(terminalId, current, e))),
    [terminalId],
  );
  return <ViewersBadge viewers={viewers} />;
}
