/** Automation tasks: scheduled, recurring, and long-running background agents. */

export type TaskKind = 'scheduled' | 'recurring' | 'background';
export type TaskStatus = 'active' | 'paused' | 'done' | 'error';
/**
 * When an automation nobody started just now may run (`run_policy.rs`):
 * `idle` waits until nobody is using the computer and it is on mains power and
 * not hot; `lowPriority` runs beside the user but not on a low battery or a hot
 * machine; `always` runs at once. Absent: the settings' `automationRunPolicy`,
 * else `idle` on a local model and `always` on a cloud one. A run held two
 * hours starts anyway, in low priority.
 */
export type AutomationRunPolicy = 'idle' | 'lowPriority' | 'always';

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
  runPolicy?: AutomationRunPolicy;

  status: TaskStatus;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  /** The chat session this task drives (reused across fires). */
  lastSessionId?: string;
  /** Snippet of the last assistant answer, for the dashboard. */
  lastResult?: string;
  /** Due, but held back by the run policy since then (epoch ms). */
  waitingSince?: number;
  /** The last run started beside the user, or after the wait cap. */
  lastRunLowPriority?: boolean;
  /** How long the last run waited for the policy, when it did. */
  lastRunWaitedMs?: number;
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
  runPolicy?: AutomationRunPolicy;
}

/** Token the agent emits to signal a background "until" condition is satisfied. */
export const TASK_DONE_TOKEN = '⟦DONE⟧';

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
