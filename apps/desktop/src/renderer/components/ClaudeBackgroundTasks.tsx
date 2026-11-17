import { useEffect, useState } from 'react';
import type { SessionSummary } from '@nekko-agent/shared';
import { getLiveRun, useLiveRunsVersion } from '../liveRuns.js';
import { useStore } from '../store.js';
import { childActivity } from '../subagentActivity.js';
import { StatusIcon } from './WorkspaceCard.js';

/**
 * How many background tasks (shell commands, sub-agents) a Claude Agent
 * chat's Claude Code still runs: read once when the chat opens, then kept
 * current by `claude_code_background` events. Claude Code keeps working after
 * a turn's Done and wakes on its own when one finishes.
 */
export function useClaudeBackgroundTasks(sessionId: string): number {
  const [tasks, setTasks] = useState(0);
  useEffect(() => {
    let live = true;
    setTasks(0);
    window.nekko.claudeBackgroundTasks?.()
      .then((all) => { if (live) setTasks(all?.[sessionId] ?? 0); })
      .catch(() => {});
    const off = window.nekko.onAgentEvent((e) => {
      if (e.type === 'claude_code_background' && e.sessionId === sessionId) setTasks(e.tasks);
    });
    return () => { live = false; off(); };
  }, [sessionId]);
  return tasks;
}

export function claudeBackgroundLabel(tasks: number): string {
  return `Claude Code is still running ${tasks} background ${tasks === 1 ? 'task' : 'tasks'}`;
}

/** A sub-agent still at work, as the chat that started it lists it. */
export interface WorkingSubagent { id: string; title: string; detail: string }

/** What the chat waits on, said once: the sub-agents, then any other background work. */
export function backgroundWorkHeading(tasks: number, agents: number): string {
  if (agents === 0) return `${claudeBackgroundLabel(tasks)}. It continues here when one finishes.`;
  const others = Math.max(0, tasks - agents);
  const waiting = `Waiting on ${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`;
  return others > 0 ? `${waiting} and ${others} other background ${others === 1 ? 'task' : 'tasks'}` : waiting;
}

/**
 * The chat's sub-agents that are working now, each with what it is doing,
 * repainted as their runs move. A Claude Agent chat's sub-agents run in the
 * background after its turn ends.
 */
export function useWorkingSubagents(children: readonly SessionSummary[]): WorkingSubagent[] {
  useLiveRunsVersion();
  return children
    .filter((child) => !!getLiveRun(child.id))
    .map((child) => ({ id: child.id, title: child.title || 'Sub-agent', detail: childActivity(child, true).detail }));
}

/**
 * Under a finished turn while work it started goes on: each working sub-agent
 * (open it to watch), and Claude Code's other background tasks as a count.
 */
export function BackgroundWork({ tasks, agents }: { tasks: number; agents: readonly WorkingSubagent[] }) {
  if (tasks <= 0 && agents.length === 0) return null;
  return <div data-claude-background role="status" className="text-xs">
    <p className="flex items-center gap-2 px-3 font-medium text-ink-soft">
      {agents.length === 0 && <StatusIcon status="working" />}
      <span>{backgroundWorkHeading(tasks, agents.length)}</span>
    </p>
    {agents.length > 0 && <ul className="mt-1">
      {agents.map((agent) => <li key={agent.id}>
        <button type="button" className="quiet-row" data-background-agent={agent.id}
          title={`Open ${agent.title}`} onClick={() => useStore.getState().openChatPane(agent.id)}>
          <StatusIcon status="working" />
          <span className="shrink-0 font-medium text-ink">{agent.title}</span>
          <span className="min-w-0 truncate text-ink-faint">{agent.detail}</span>
        </button>
      </li>)}
    </ul>}
  </div>;
}

/** The line under a finished turn while Claude Code still works in the background. */
export function ClaudeBackgroundTasks({ tasks }: { tasks: number }) {
  return <BackgroundWork tasks={tasks} agents={[]} />;
}

/** {@link BackgroundWork} for a chat, with its working sub-agents read live. */
export function ChatBackgroundWork({ tasks, subAgents }: { tasks: number; subAgents: readonly SessionSummary[] }) {
  return <BackgroundWork tasks={tasks} agents={useWorkingSubagents(subAgents)} />;
}
