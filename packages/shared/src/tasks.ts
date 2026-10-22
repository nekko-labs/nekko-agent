/** Automation tasks: scheduled, recurring, and long-running background agents. */

export type TaskKind = 'scheduled' | 'recurring' | 'background';
export type TaskStatus = 'active' | 'paused' | 'done' | 'error';
/** How long a background agent stays alive. */
export type KeepAlive = 'forever' | 'until';

export interface AutomationTask {
  id: string;
  title: string;
  kind: TaskKind;
  /** The instruction the agent runs each time the task fires. */
  prompt: string;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;

  /** scheduled: when to run (epoch ms, one-shot). */
  runAt?: number;
  /** recurring/background: how often to fire (ms between runs). */
  intervalMs?: number;

  /** background: keep firing forever, or until a condition is met. */
  keepAlive?: KeepAlive;
  /** background + keepAlive 'until': the stop condition (advisory, agent-judged). */
  condition?: string;

  status: TaskStatus;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  /** The chat session this task drives (reused across fires). */
  lastSessionId?: string;
  /** Snippet of the last assistant answer, for the dashboard. */
  lastResult?: string;
}

/** Fields accepted when creating a task. */
export interface NewTask {
  title: string;
  kind: TaskKind;
  prompt: string;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;
  runAt?: number;
  intervalMs?: number;
  keepAlive?: KeepAlive;
  condition?: string;
}

/** A human label for a task's schedule/cadence. */
export function taskCadence(t: AutomationTask): string {
  if (t.kind === 'scheduled') return t.runAt ? `once at ${new Date(t.runAt).toLocaleString()}` : 'once';
  if (t.kind === 'recurring') return `every ${formatInterval(t.intervalMs ?? 0)}`;
  return t.keepAlive === 'until' ? `until: ${t.condition || 'condition met'}` : 'runs forever';
}

export function formatInterval(ms: number): string {
  if (ms <= 0) return 'run';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hr = min / 60;
  if (hr < 24) return `${Number.isInteger(hr) ? hr : hr.toFixed(1)} hr`;
  const d = hr / 24;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`;
}
