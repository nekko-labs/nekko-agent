import type { AgentEvent, Workflow, WorkflowRun } from '@nekko-agent/shared';
import { runOutcome, summarizeAsk } from '@nekko-agent/shared';

export interface NotificationContext {
  /** Whether notifications are enabled in Settings. */
  enabled: boolean;
  /** The window is hidden, minimized or behind another app. */
  windowHidden: boolean;
  /** The chat whose pane is on screen, if the chat view is showing. */
  visibleSessionId: string | null;
  /** The chat's title, for the body. */
  titleOf: (sessionId: string) => string | undefined;
}

export interface Notice {
  /** The chat a click opens; for a workflow run, `run:<id>` (it opens `link`). */
  sessionId: string;
  kind: 'finished' | 'failed' | 'question' | 'approval' | 'run-failed' | 'run-finished';
  title: string;
  body: string;
  /** Where a click goes, when not the chat (a workflow run). */
  link?: string;
}

/** Events that are not failures, just the user pressing Stop. */
const STOPS = new Set(['Stopped', 'Aborted', 'This operation was aborted']);

/** What, if anything, to tell the user about an event. Pure. */
export function decideNotification(event: AgentEvent, ctx: NotificationContext): Notice | null {
  if (!ctx.enabled) return null;
  if ((event as { relayOnly?: boolean }).relayOnly) return null;
  // A chat on screen in a focused window needs no toast; its pane shows it.
  if (!ctx.windowHidden && ctx.visibleSessionId === event.sessionId) return null;
  const chat = ctx.titleOf(event.sessionId)?.trim() || 'A chat';
  switch (event.type) {
    case 'done':
      return { sessionId: event.sessionId, kind: 'finished', title: 'Reply finished', body: chat };
    case 'error':
      if (STOPS.has(event.message.trim())) return null;
      return { sessionId: event.sessionId, kind: 'failed', title: 'Reply failed', body: `${chat}: ${event.message.slice(0, 120)}` };
    case 'question':
      return { sessionId: event.sessionId, kind: 'question', title: 'Nekko Agent has a question', body: `${chat}: ${summarizeAsk(event.request).slice(0, 120)}` };
    case 'tool_approval_required':
      return { sessionId: event.sessionId, kind: 'approval', title: 'Approval needed', body: `${chat}: ${event.reason || event.call.name}` };
    default:
      return null;
  }
}

/** Opens a workflow run in the Workflows view. */
export function workflowRunLink(workflowId: string, runId: string): string {
  return `nekko-agent://workflow/run?workflow=${encodeURIComponent(workflowId)}&run=${encodeURIComponent(runId)}`;
}

/** Only workflow run links, never arbitrary commands. */
export function parseWorkflowRunLink(raw: string): { workflowId: string; runId: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'nekko-agent:' || url.hostname !== 'workflow' || url.pathname !== '/run') return null;
    const workflowId = url.searchParams.get('workflow');
    const runId = url.searchParams.get('run');
    return workflowId && runId ? { workflowId, runId } : null;
  } catch { return null; }
}

export interface RunNoticeContext {
  enabled: boolean;
  /** The Workflows view is on screen in a focused window: its rows already say it. */
  workflowsVisible: boolean;
}

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/**
 * What, if anything, to tell the user about a finished workflow run. Failures
 * notify unless the workflow says never; passes only when it asks for every
 * run (a digest). Pure.
 */
export function decideRunNotice(run: WorkflowRun, wf: Pick<Workflow, 'id' | 'name' | 'notify' | 'steps'>, ctx: RunNoticeContext): Notice | null {
  if (!ctx.enabled || ctx.workflowsVisible) return null;
  const notify = wf.notify ?? 'failure';
  if (notify === 'off') return null;
  const link = workflowRunLink(wf.id, run.id);
  const { failed, result } = runOutcome(run, wf.steps);
  if (run.status === 'failure') {
    const why = firstLine(failed?.text ?? '') || firstLine(run.message ?? '') || 'A step failed.';
    const body = failed ? `At "${failed.name}": ${why}` : why;
    return { sessionId: `run:${run.id}`, kind: 'run-failed', title: `${wf.name} failed`, body: body.slice(0, 120), link };
  }
  if (run.status === 'success' && notify === 'always') {
    const body = firstLine(result?.text ?? '') || 'The run passed.';
    return { sessionId: `run:${run.id}`, kind: 'run-finished', title: `${wf.name} finished`, body: body.slice(0, 120), link };
  }
  return null;
}

