import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { stableSelector } from '../selectStable.js';
import { useLiveRunsVersion } from '../liveRuns.js';
import { waitingOn, type SubagentWait } from '../subagentActivity.js';

const ASK: Record<SubagentWait, string> = { approval: 'your approval', question: 'your answer', secret: 'a secret' };

/**
 * The sub-agents below a chat (children, their children, …) that wait on the
 * person, those waiting for approval first. Pure, for the tests.
 */
/** Every sub-agent below a chat, so a subscriber re-renders only when one of them changes. */
export function descendantSessions(sessionId: string, sessions: SessionSummary[]): SessionSummary[] {
  const below = new Set([sessionId]);
  const found: SessionSummary[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sessions) {
      if (!s.parentSessionId || !below.has(s.parentSessionId) || below.has(s.id)) continue;
      below.add(s.id);
      found.push(s);
      grew = true;
    }
  }
  return found;
}

export function waitingDescendants(sessionId: string, sessions: SessionSummary[]): { child: SessionSummary; wait: SubagentWait }[] {
  const below = new Set([sessionId]);
  const found: { child: SessionSummary; wait: SubagentWait }[] = [];
  // Breadth first over the parent links; the set stops a cycle.
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sessions) {
      if (!s.parentSessionId || !below.has(s.parentSessionId) || below.has(s.id)) continue;
      below.add(s.id);
      grew = true;
      const wait = waitingOn(s.id);
      if (wait) found.push({ child: s, wait });
    }
  }
  return found.sort((a, b) => Number(b.wait === 'approval') - Number(a.wait === 'approval'));
}

const descendantsOf = stableSelector((s: { sessions?: SessionSummary[] }, id) => descendantSessions(id, s.sessions ?? []));

/**
 * A line above the composer while a sub-agent of this chat waits on the
 * person, so the parent chat says so and one click opens the waiting chat
 * (#3270). Without it the run looked busy until the sub-agent was opened.
 */
export function SubagentWaitNotice({ sessionId, onOpen }: { sessionId: string; onOpen: (id: string) => void }) {
  useLiveRunsVersion();
  const below = useStore((s) => descendantsOf(s, sessionId));
  const waiting = waitingDescendants(sessionId, below);
  if (!waiting.length) return null;
  const [{ child, wait }] = waiting;
  const title = child.title || 'Sub-agent';
  const text = waiting.length === 1
    ? `Sub-agent “${title}” is waiting for ${ASK[wait]}.`
    : `${waiting.length} sub-agents are waiting for you, starting with “${title}”.`;
  return (
    <div className="chat-long-note" role="status" data-subagent-wait={child.id}>
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--warning)' }} />
      <span className="min-w-0 flex-1" dir="auto">{text}</span>
      <button type="button" className="btn btn-outline h-7 px-2.5 py-0 text-xs" aria-label={`Open sub-agent: ${title}`} onClick={() => onOpen(child.id)}>Open</button>
    </div>
  );
}
