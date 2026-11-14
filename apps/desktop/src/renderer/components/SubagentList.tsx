import { useEffect, useId, useState, type Ref } from 'react';
import type { SessionSummary } from '@nekko-agent/shared';
import { subagentRows } from '../views/unopenedChats.js';
import { StatusIcon, agentStatusOfLane, type AgentStatus } from './WorkspaceCard.js';
import { wakeSourcesOf } from '../views/agentPanelView.js';
import { ChevronIcon } from '../icons.js';
import { SubagentRoute } from './SubagentRoute.js';

/** A compact tree per parent. The setting chooses its initial disclosure state. */
export function SubagentList({ children, statuses, selectedId, expandByDefault, activeRowRef, onOpen }: {
  children: SessionSummary[];
  statuses: Map<string, AgentStatus>;
  selectedId?: string | null;
  expandByDefault: boolean;
  activeRowRef?: Ref<HTMLDivElement>;
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(expandByDefault);
  const restId = useId();
  useEffect(() => setExpanded(expandByDefault), [expandByDefault]);
  const rows = subagentRows(children);
  const extra = rows.length - 2;
  const row = (session: SessionSummary, index: number) => <div key={session.id} ref={session.id === selectedId ? activeRowRef : undefined}>
    <button type="button" onClick={() => onOpen(session.id)} data-subagent-row={session.id}
      className={`subagent-row relative flex items-center gap-2 rounded-lg py-1 pl-7 pr-2 text-left text-xs transition-colors duration-(--dur-fast) ${session.id === selectedId ? 'bg-accent-soft text-ink' : 'text-ink-soft hover:bg-surface-2'}`}>
      <span aria-hidden data-subagent-tree={index === rows.length - 1 || (!expanded && index === 1) ? 'last' : 'tee'} className="subagent-tree" />
      <StatusIcon status={statuses.get(session.id) ?? agentStatusOfLane('idle', undefined, wakeSourcesOf(session))} />
      <span className="min-w-0 flex-1">
        <span data-subagent-title className="block truncate font-semibold text-ink" title={session.title} dir="auto">{session.title || 'Untitled chat'}</span>
        <SubagentRoute child={session} modelFirst />
      </span>
    </button>
  </div>;
  if (!rows.length) return null;
  return <div data-subagent-list>
    {rows.slice(0, 2).map(row)}
    {extra > 0 && <>
      <div id={restId} className={`collapse-wrap ${expanded ? '' : 'collapsed'}`} inert={!expanded || undefined} aria-hidden={!expanded || undefined}>
        <div className="min-h-0 overflow-hidden">{rows.slice(2).map((session, index) => row(session, index + 2))}</div>
      </div>
      <button type="button" data-subagent-toggle aria-expanded={expanded} aria-controls={restId}
        className="flex w-full items-center gap-1 rounded-md py-1 pl-11 pr-2 text-left text-2xs text-ink-soft transition-colors duration-(--dur-fast) hover:bg-surface-2 hover:text-ink"
        onClick={() => setExpanded(value => !value)}>
        <ChevronIcon className={`h-3 w-3 transition-transform duration-(--dur-med) ${expanded ? '-rotate-90' : 'rotate-90'}`} />
        {expanded ? 'Show less' : `Show more (${extra})`}
      </button>
    </>}
  </div>;
}
