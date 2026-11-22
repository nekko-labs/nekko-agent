import { useEffect, useId, useState, type Ref } from 'react';
import type { PrInfo, SessionSummary } from '@nekko-agent/shared';
import { subagentRows } from '../views/unopenedChats.js';
import { StatusIcon, agentStatusOfLane, type AgentStatus } from './WorkspaceCard.js';
import { wakeSourcesOf } from '../views/agentPanelView.js';
import { ChevronIcon } from '../icons.js';
import { SubagentRoute } from './SubagentRoute.js';
import { SessionPrChip } from './SessionPrChip.js';
import { useStore } from '../store.js';
import { useGitStatus } from '../useGitStatus.js';

/** PRs by URL, the branch's own first, so one PR is never counted twice. */
function mergePrs(branchPr: PrInfo | undefined, mentioned: PrInfo[] | undefined): PrInfo[] {
  const out = new Map<string, PrInfo>();
  if (branchPr) out.set(branchPr.url, branchPr);
  for (const p of mentioned ?? []) if (!out.has(p.url)) out.set(p.url, p);
  return [...out.values()];
}

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
  if (!rows.length) return null;
  const renderRow = (session: SessionSummary, index: number, last: boolean) => <SubagentRow
    key={session.id}
    session={session}
    status={statuses.get(session.id) ?? agentStatusOfLane('idle', undefined, wakeSourcesOf(session))}
    selected={session.id === selectedId}
    last={last}
    rowRef={session.id === selectedId ? activeRowRef : undefined}
    onOpen={onOpen}
  />;
  return <div data-subagent-list>
    {rows.slice(0, 2).map((session, index) => renderRow(session, index, index === rows.length - 1 || (!expanded && index === 1)))}
    {extra > 0 && <>
      <div id={restId} className={`collapse-wrap ${expanded ? '' : 'collapsed'}`} inert={!expanded || undefined} aria-hidden={!expanded || undefined}>
        <div className="min-h-0 overflow-hidden">{rows.slice(2).map((session, index) => renderRow(session, index + 2, index + 2 === rows.length - 1))}</div>
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

/**
 * One child row. Lives in its own component so each row can read its session's
 * PRs with hooks, the way `WorkspaceCard` does: the branch's own PR from
 * `useGitStatus`, plus any mentioned in the transcript, merged and shown as a
 * `SessionPrChip` on the title line.
 */
function SubagentRow({ session, status, selected, last, rowRef, onOpen }: {
  session: SessionSummary;
  status: AgentStatus;
  selected: boolean;
  last: boolean;
  rowRef?: Ref<HTMLDivElement>;
  onOpen: (id: string) => void;
}) {
  const mentionedPrs = useStore(s => s.prsBySession?.[session.id]);
  const git = useGitStatus(`session:${session.id}`);
  const prs = mergePrs(git?.pr, mentionedPrs);
  return <div ref={rowRef}>
    <button type="button" onClick={() => onOpen(session.id)} data-subagent-row={session.id}
      className={`subagent-row relative flex items-center gap-2 rounded-lg py-1 pl-7 pr-2 text-left text-xs transition-colors duration-(--dur-fast) ${selected ? 'bg-accent-soft text-ink' : 'text-ink-soft hover:bg-surface-2'}`}>
      <span aria-hidden data-subagent-tree={last ? 'last' : 'tee'} className="subagent-tree" />
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span data-subagent-title className="min-w-0 flex-1 truncate font-semibold text-ink" title={session.title} dir="auto">{session.title || 'Untitled chat'}</span>
          {prs.length > 0 && <span className="ml-auto inline-flex shrink-0 pl-1 text-2xs leading-[15px]"><SessionPrChip prs={prs} /></span>}
        </span>
        <SubagentRoute child={session} modelFirst />
      </span>
    </button>
  </div>;
}
