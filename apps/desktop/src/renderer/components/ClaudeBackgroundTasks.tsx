import { useEffect, useState } from 'react';

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

/** The line under a finished turn while Claude Code still works in the background. */
export function ClaudeBackgroundTasks({ tasks }: { tasks: number }) {
  if (tasks <= 0) return null;
  return <div data-claude-background role="status" className="flex items-center gap-2 px-1 text-[12px] text-ink-soft">
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
    <span>{claudeBackgroundLabel(tasks)}. It continues here when one finishes.</span>
  </div>;
}
