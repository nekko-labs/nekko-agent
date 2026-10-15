import { chatArtifacts } from '../chatArtifacts.js';
import { ChatArtifacts } from './ChatArtifacts.js';
import React, { useEffect, useMemo, useRef } from 'react';
import type { QueuedPrompt, Session } from '@nekko-agent/shared';
import { DEFAULT_ORCHESTRATION, getStrategy, planProgress, queueItemPayload } from '@nekko-agent/shared';
import { useLiveRunsVersion, getLiveRun, runningSessionIds } from '../liveRuns.js';
import { childActivity, activitySentence } from '../subagentActivity.js';
import { useStore } from '../store.js';
import { CheckIcon, ChatIcon, ControlPanelIcon, PencilIcon, RobotIcon } from '../icons.js';

/** The agent's published plan, active delegates and queued follow-ups. */
function queueLabel(item: QueuedPrompt): string {
  const payload = queueItemPayload(item);
  const bits = [payload.text || '(no text)'];
  if (payload.skill) bits.push(`/${payload.skill.name}`);
  if (payload.images?.length) bits.push(`${payload.images.length} image${payload.images.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export const PLAN_CHANGE_REQUEST = 'Please revise the current agent plan. I would like to change the approach as follows:\n';

export function appendPlanChangeRequest(draft: string): string {
  return draft.trim() ? `${draft}\n\n${PLAN_CHANGE_REQUEST}` : PLAN_CHANGE_REQUEST;
}

export function PlanRail({ sessionId, session, streaming, onChangePlan }: {
  sessionId: string;
  session: Session | null;
  streaming: boolean;
  /** Opens an editable follow-up, never mutates or submits the plan directly. */
  onChangePlan?: () => void;
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
  const agentPlan = session?.agentPlan;
  const progress = planProgress(agentPlan);
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
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
        <ControlPanelIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        {/* The chat area's floating plan toggle opens and closes this panel. */}
        <span className="min-w-0 flex-1 truncate pr-8 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Agent Monitor</span>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <details key={sessionId} className="group">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Artifacts <span className="ml-1 tabular-nums">{artifacts.length}</span></summary>
          {artifacts.length ? <ChatArtifacts artifacts={artifacts} sessionId={sessionId} /> : <p className="mt-2 text-[11px] text-ink-faint">No artifacts yet.</p>}
        </details>
        <section>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Sub-agents</span>
            {activeChildren.length > 0 && <span className="text-[10px] tabular-nums text-ink-faint">{activeChildren.length}</span>}
          </div>
          {activeChildren.length === 0 ? <p className="px-0.5 text-[11px] leading-snug text-ink-faint">{spawnAllowed ? 'No sub-agents working right now.' : 'Delegation is off. Enable it in Settings → Orchestration.'}</p> : (
            <div className="space-y-0.5">{activeChildren.map((c) => {
              const a = childActivity(c, !!getLiveRun(c.id));
              return <button key={c.id} className="flex w-full items-start gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-surface-2" onClick={() => openChatPane(c.id)} title={`Open ${c.title}`}>
                <RobotIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1"><span className="block truncate text-[12px] text-ink-soft">{c.title}</span>
                  <span className="block truncate text-[10px] text-ink-faint">{activitySentence(a)}</span>
                </span>
              </button>;
            })}</div>
          )}
        </section>
        <section>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Agent plan</span>
            {!!agentPlan?.length && <span className="text-[10px] tabular-nums text-ink-faint">{progress.done + progress.skipped}/{progress.total}</span>}
            {streaming && <span className="h-1.5 w-1.5 animate-pulse" style={{ background: 'var(--accent)' }} title="The agent is working" />}
          </div>
          {agentPlan?.length ? (
            <ol className="space-y-0.5">
              {agentPlan.map((step) => (
                <li key={step.id} className="group flex items-start gap-1.5 rounded-lg px-1 py-0.5">
                  <span className="mt-[5px] shrink-0">
                    {step.status === 'done' ? <CheckIcon className="h-3 w-3 text-success" /> :
                      <span className="block h-2.5 w-2.5 rounded-full border" style={{ borderColor: step.status === 'active' ? 'var(--accent)' : 'var(--ink-faint)', background: step.status === 'active' ? 'var(--accent)' : 'transparent' }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block break-words text-[12px] leading-snug ${step.status === 'skipped' ? 'text-ink-faint line-through' : 'text-ink-soft'}`}>{step.title}</span>
                    {step.note && <span className="block break-words text-[10px] text-ink-faint">{step.note}</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="px-0.5 text-[11px] leading-snug text-ink-faint">{streaming ? 'Waiting for the agent to publish its plan.' : 'The agent’s plan will appear here when it starts work.'}</p>}
          {!!agentPlan?.length && <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-soft hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50" disabled={!onChangePlan} onClick={onChangePlan} title="Describe a plan adjustment in the composer before sending"><PencilIcon className="h-3 w-3" />Change plan</button>}
        </section>
        {queued.length > 0 && <section>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">After this · {queued.length}</div>
          {queued.map((q, i) => {
            const payload = queueItemPayload(q);
            const label = queueLabel(q);
            return <div key={i} className="flex items-start gap-1.5 px-1 py-0.5"><ChatIcon className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" /><span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={label}>{label}</span>{payload.skill && <span className="text-[10px] text-ink-faint">/{payload.skill.name}</span>}{!!payload.images?.length && <span className="text-[10px] text-ink-faint">{payload.images.length} img</span>}</div>;
          })}
        </section>}
      </div>
    </aside>
  );
}
