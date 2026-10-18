import { useEffect, useRef, useState } from 'react';
import type { PendingInput, SessionSummary } from '@nekko-agent/shared';
import { useLiveRunsVersion } from '../liveRuns.js';
import { childActivity, activitySentence } from '../subagentActivity.js';
import { RobotIcon } from '../icons.js';
import { shortModelName } from './agent-console/SubagentCue.js';

/** Only active children belong in this transient window-local indicator. */
export function WorkingSubagents({ children, running, pending, onOpen }: {
  children: SessionSummary[];
  running: Set<string>;
  pending: Record<string, PendingInput>;
  onOpen: (id: string) => void;
}) {
  useLiveRunsVersion();
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = children.filter(child => running.has(child.id));
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
    };
  }, [expanded]);
  useEffect(() => {
    if (!active.length) setExpanded(false);
  }, [active.length]);
  if (!active.length) return null;
  const waiting = active.some(child => pending[child.id]?.question || pending[child.id]?.approval);
  return <div ref={root} className="absolute bottom-3 right-3 z-20 flex flex-col items-end" data-working-subagents>
    {expanded && <div className="card mb-2 max-h-48 w-64 overflow-y-auto p-1" role="group" aria-label="Working subagents">
      {active.map(child => <button key={child.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] hover:bg-surface-2" onClick={() => onOpen(child.id)}>
        <RobotIcon className="h-4 w-4 shrink-0" />
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: pending[child.id]?.question || pending[child.id]?.approval ? 'var(--warning)' : 'var(--success)' }} />
        <span className="min-w-0"><span className="block truncate">{child.title || 'Subagent'}{child.modelId && <span className="text-ink-faint" title={`Model: ${child.modelId}`}> · {shortModelName(child.modelId)}</span>}</span><span className="block truncate text-ink-faint">{activitySentence(childActivity(child, running.has(child.id), pending[child.id]))}</span></span>
      </button>)}
    </div>}
    <button type="button" className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] shadow-md" aria-expanded={expanded} aria-label={`${active.length} working subagents`} onClick={() => setExpanded(!expanded)}>
      <RobotIcon className="h-4 w-4" />
      <span className="h-2 w-2 rounded-full" style={{ background: waiting ? 'var(--warning)' : 'var(--success)' }} />
      <span>{active.length}</span>
    </button>
  </div>;
}
