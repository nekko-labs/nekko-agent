import { useMemo } from 'react';
import { useStore } from '../../store.js';
import { getLiveRun, useLiveRunsVersion } from '../../liveRuns.js';
import { RobotIcon } from '../../icons.js';

/** The label the chip reads, or null when nothing is running. */
export function subagentsRunningLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} subagent${count === 1 ? '' : 's'} running`;
}

/**
 * Floats in the bottom-right corner of an agent's transcript while any of its
 * sub-agents has a turn in flight. Clicking it opens the plan rail, which
 * lists each sub-agent and what it is doing.
 */
export function SubagentsRunningChip({ sessionId, onOpen }: { sessionId: string; onOpen?: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const childIds = useMemo(() => sessions.filter((s) => s.parentSessionId === sessionId).map((s) => s.id), [sessions, sessionId]);
  // Re-read on any live-run change; the children come and go as they spawn.
  useLiveRunsVersion();
  const running = childIds.filter((id) => getLiveRun(id)).length;
  const label = subagentsRunningLabel(running);
  if (!label) return null;
  return <SubagentsRunningChipView label={label} onOpen={onOpen} />;
}

/** Presentational half, rendered directly by tests. */
export function SubagentsRunningChipView({ label, onOpen }: { label: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      data-subagents-running
      className="fade-in absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-accent shadow-md hover:text-ink"
      style={{ background: 'var(--surface)' }}
      onClick={onOpen}
      title="Show sub-agents in the plan panel"
      aria-label={label}
    >
      <RobotIcon className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </button>
  );
}
