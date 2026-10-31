import { chatArtifacts } from '../chatArtifacts.js';
import { MonitorArtifacts } from './MonitorArtifacts.js';
import { MonitorProject } from './MonitorProject.js';
import React, { useEffect, useMemo, useRef } from 'react';
import type { QueuedPrompt, Session } from '@nekko-agent/shared';
import { DEFAULT_ORCHESTRATION, getStrategy, queueItemPayload } from '@nekko-agent/shared';
import { useLiveRunsVersion, getLiveRun, runningSessionIds } from '../liveRuns.js';
import { childActivity, activitySentence } from '../subagentActivity.js';
import { useStore } from '../store.js';
import { ChatIcon, ControlPanelIcon, MinimizeIcon, RobotIcon } from '../icons.js';

/** Artifacts, project, active delegates and queued follow-ups. The plan itself rides the composer (PlanSheet). */
function queueLabel(item: QueuedPrompt): string {
  const payload = queueItemPayload(item);
  const bits = [payload.text || '(no text)'];
  if (payload.skill) bits.push(`/${payload.skill.name}`);
  if (payload.images?.length) bits.push(`${payload.images.length} image${payload.images.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}


export function PlanRail({ sessionId, session, onMinimize }: {
  sessionId: string;
  session: Session | null;
  /** Closes the panel; the floating Agent Monitor button then reopens it. */
  onMinimize?: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const openChatPane = useStore((s) => s.openChatPane);
  const orchestration = useStore((s) => s.settings?.orchestration);
  const spawnAllowed = getStrategy((orchestration ?? DEFAULT_ORCHESTRATION).strategy).allowsSpawn;
  const children = useMemo(() => sessions.filter((s) => s.parentSessionId === sessionId), [sessions, sessionId]);
  const activityVersion = useLiveRunsVersion();
  const discovered = useRef(new Set<string>());
  useEffect(() => {
    const unknown = runningSessionIds().filter(id => id !== sessionId && !sessions.some(s => s.id === id) && !discovered.current.has(id));
    if (!unknown.length) return;
    unknown.forEach(id => discovered.current.add(id));
    void useStore.getState().refreshSessions();
  }, [activityVersion, sessions, sessionId]);
  // Keep completed delegates available here until the user chooses to open
  // them; spawning alone never opens another window.
  const activeChildren = children;
  const queued = session?.queue ?? [];
  const settings = useStore(s => s.settings);
  const basePath = session?.workspaceId ? session.gitWorktrees?.[session.workspaceId]?.path ?? settings?.workspaces.find(w => w.id === session.workspaceId)?.path : undefined;
  const artifacts = useMemo(() => {
    const unique = new Map();
    for (const message of session?.messages ?? []) if (message.role === 'assistant') for (const artifact of chatArtifacts(message.content, basePath)) unique.set(artifact.path.toLowerCase(), artifact);
    return [...unique.values()];
  }, [session?.messages, basePath]);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-line" style={{ background: 'transparent' }} aria-label="Plan and sub-agents">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <ControlPanelIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-ink-faint">Agent Monitor</span>
        {/* Minimizing hides the panel and brings back the chat area's floating
            Agent Monitor button, which reopens it. */}
        {onMinimize && <button type="button" className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink" data-plan-minimize onClick={onMinimize} title="Minimize Agent Monitor" aria-label="Minimize Agent Monitor"><MinimizeIcon className="h-3.5 w-3.5" /></button>}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <MonitorArtifacts key={sessionId} sessionId={sessionId} artifacts={artifacts} hydrated={!!session && session.id === sessionId && Array.isArray(session.messages)} />
        <MonitorProject sessionId={sessionId} projectPath={basePath} />
        <section>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">Sub-agents</span>
            {activeChildren.length > 0 && <span className="text-2xs tabular-nums text-ink-faint">{activeChildren.length}</span>}
          </div>
          {activeChildren.length === 0 ? <p className="px-0.5 text-2xs leading-snug text-ink-faint">{spawnAllowed ? 'No sub-agents working right now.' : 'Delegation is off. Enable it in Settings → Orchestration.'}</p> : (
            <div className="space-y-0.5">{activeChildren.map((c) => {
              const a = childActivity(c, !!getLiveRun(c.id));
              return <button key={c.id} className="flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-2" onClick={() => openChatPane(c.id)} title={`Open ${c.title}`}>
                <RobotIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1"><span className="block truncate text-xs text-ink-soft">{c.title}</span>
                  <span className="block truncate text-2xs text-ink-faint">{activitySentence(a)}</span>
                </span>
              </button>;
            })}</div>
          )}
        </section>
        {queued.length > 0 && <section>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">After this · {queued.length}</div>
          {queued.map((q, i) => {
            const payload = queueItemPayload(q);
            const label = queueLabel(q);
            return <div key={i} className="flex items-start gap-2 px-1 py-0.5"><ChatIcon className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" /><span className="min-w-0 flex-1 truncate text-2xs text-ink-faint" title={label}>{label}</span>{payload.skill && <span className="text-2xs text-ink-faint">/{payload.skill.name}</span>}{!!payload.images?.length && <span className="text-2xs text-ink-faint">{payload.images.length} img</span>}</div>;
          })}
        </section>}
      </div>
    </aside>
  );
}
