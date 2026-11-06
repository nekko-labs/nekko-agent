import React from 'react';
import { useStore } from '../store.js';
import { useWallLogs } from '../wallLogs.js';
import { DiffIcon, FolderIcon, GlobeIcon } from '../icons.js';
import { useExpertMode, useShown } from '../simpleMode.js';

export type CompanionKind = 'diff' | 'browser' | 'files';

const KINDS: Array<{ kind: CompanionKind; label: string; title: string; Icon: (p: { className?: string }) => React.JSX.Element }> = [
  { kind: 'diff', label: 'Changes', title: "Review this agent's file changes", Icon: DiffIcon },
  { kind: 'files', label: 'Files', title: "Browse this agent's working folder", Icon: FolderIcon },
  { kind: 'browser', label: 'Browser', title: 'Open a browser beside this agent', Icon: GlobeIcon },
];

/**
 * Open one of a chat's companions. On the Agents wall it slides out of the
 * window's right edge as a drawer, like Logs (clicking again closes it); in
 * the Chat view it opens as a window of the chat's workspace.
 */
export function openAgentCompanion(sessionId: string, kind: CompanionKind, commandCenter: boolean): void {
  if (commandCenter) { useWallLogs.getState().toggle(sessionId, kind); return; }
  const st = useStore.getState();
  if (kind === 'diff') st.openDiffPane(sessionId);
  else st.openCompanion(sessionId, kind);
}

/**
 * Changes, Files and Browser for one agent, in its own header next to Logs.
 * Changes shows only while the agent has changed files, and says how many:
 * "3 files changed", with the lines added and removed in Expert.
 */
export function AgentCompanionButtons({ sessionId, changeCount, added = 0, removed = 0, commandCenter, compact }: {
  sessionId: string;
  changeCount: number;
  added?: number;
  removed?: number;
  commandCenter: boolean;
  compact: boolean;
}) {
  const open = useWallLogs((s) => commandCenter && s.sessionId === sessionId && !s.closing ? s.kind : null);
  // An open drawer keeps its button, so the way to close it never disappears.
  const showChanges = useShown('changes', { changes: changeCount > 0 || open === 'diff' });
  const [expert] = useExpertMode();
  return (
    <span className="contents" role="group" aria-label="Agent companions">
      {KINDS.filter((k) => k.kind !== 'diff' || showChanges).map(({ kind, label, title, Icon }) => {
        const count = kind === 'diff' && changeCount > 0 ? changeCount : 0;
        return (
          <button
            key={kind}
            type="button"
            className={`btn btn-ghost shrink-0 gap-1 px-2 py-1 text-2xs ${count || open === kind ? 'font-medium text-accent' : ''} ${count ? 'agent-changes-pending' : ''}`}
            aria-label={count ? `${label} (${count})` : label}
            title={count ? `${title} (${count} changed file${count === 1 ? '' : 's'})` : title}
            data-agent-companion={kind}
            aria-expanded={commandCenter ? open === kind : undefined}
            onClick={() => openAgentCompanion(sessionId, kind, commandCenter)}
          >
            <Icon className="h-3.5 w-3.5" />
            {count > 0 && <span className="agent-change-summary">{expert && <><span className="text-success">+{added}</span><span className="text-danger">−{removed}</span></>}<span>{count} file{count === 1 ? '' : 's'} changed</span></span>}
          </button>
        );
      })}
    </span>
  );
}
