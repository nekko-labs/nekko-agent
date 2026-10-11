import React from 'react';
import { useStore } from '../store.js';
import { DiffIcon, FolderIcon, GlobeIcon } from '../icons.js';

export type CompanionKind = 'diff' | 'browser' | 'files';

/** Fired so the Agents wall unfolds a window's companions after one is opened from inside it. */
export const COMPANION_OPENED_EVENT = 'nekko:companion-opened';

const KINDS: Array<{ kind: CompanionKind; label: string; title: string; Icon: (p: { className?: string }) => React.JSX.Element }> = [
  { kind: 'diff', label: 'Changes', title: "Review this agent's file changes", Icon: DiffIcon },
  { kind: 'files', label: 'Files', title: "Browse this agent's working folder", Icon: FolderIcon },
  { kind: 'browser', label: 'Browser', title: 'Open a browser beside this agent', Icon: GlobeIcon },
];

/** Open one of a chat's companions and, on the wall, make sure it shows. */
export function openAgentCompanion(sessionId: string, kind: CompanionKind, commandCenter: boolean): void {
  const st = useStore.getState();
  if (!commandCenter && kind === 'diff') { st.openDiffPane(sessionId); return; }
  if (st.openCompanion(sessionId, kind)) window.dispatchEvent(new CustomEvent(COMPANION_OPENED_EVENT, { detail: { sessionId, kind } }));
}

/**
 * Changes, Files and Browser for one agent, in its own header next to Logs.
 * Changes carries the count when there is one, so it doubles as the
 * "N changes" chip it replaces.
 */
export function AgentCompanionButtons({ sessionId, changeCount, commandCenter, compact }: {
  sessionId: string;
  changeCount: number;
  commandCenter: boolean;
  compact: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center" role="group" aria-label="Agent companions">
      {KINDS.map(({ kind, label, title, Icon }) => {
        const count = kind === 'diff' && changeCount > 0 ? changeCount : 0;
        return (
          <button
            key={kind}
            type="button"
            className={`btn btn-ghost shrink-0 gap-1 px-1.5 py-1 text-[11px] ${count ? 'font-medium text-accent' : ''}`}
            aria-label={count ? `${label} (${count})` : label}
            title={count ? `${title} (${count} changed file${count === 1 ? '' : 's'})` : title}
            data-agent-companion={kind}
            onClick={() => openAgentCompanion(sessionId, kind, commandCenter)}
          >
            <Icon className="h-3.5 w-3.5" />
            {count > 0 && !compact && <span>{count}</span>}
          </button>
        );
      })}
    </span>
  );
}
