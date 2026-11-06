import type { LiveActivity } from '@nekko-agent/shared';
import type { Activity } from './transcript.js';

/** Completion belongs to each call, including older concurrent calls. */
export function isRunningTool(item: Activity, pendingCallId?: string): boolean {
  return item.kind === 'tool' && item.endedAt === undefined && !item.result && item.call.id !== pendingCallId;
}

export const TOOL_PROGRESS_MINUTE_MS = 60_000;

/** Missing/capped steps are unknown, not evidence that a tool is still running.
 * Any observed run update resets the quiet period: we cannot attribute progress
 * to individual tools, so prefer understating inactivity to claiming a hang. */
export function toolQuietSince(activity: LiveActivity | undefined, callId: string): number | undefined {
  const step = activity?.steps.find((s) => s.kind === 'tool' && s.id === callId);
  if (!activity || step?.status !== 'running') return undefined;
  const since = Math.max(step.at, activity.updatedAt);
  return Number.isFinite(since) ? since : undefined;
}

export function quietMinutes(since: number, now: number): number {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return 0;
  return Math.floor(Math.max(0, now - since) / TOOL_PROGRESS_MINUTE_MS);
}

/** One wake per minute boundary, not per frame/second. Re-read wall time after
 * sleep or a throttled background timer instead of counting timer ticks. */
export function watchQuietMinutes(since: number, onChange: (minutes: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let previous = quietMinutes(since, Date.now());
  function schedule() {
    if (stopped || !Number.isFinite(since)) return;
    const now = Date.now();
    const elapsed = Math.max(0, now - since);
    const delay = now < since
      ? since - now + TOOL_PROGRESS_MINUTE_MS
      : TOOL_PROGRESS_MINUTE_MS - elapsed % TOOL_PROGRESS_MINUTE_MS;
    timer = setTimeout(() => {
      if (stopped) return;
      const minutes = quietMinutes(since, Date.now());
      if (minutes !== previous) {
        previous = minutes;
        onChange(minutes);
      }
      schedule();
    }, Math.min(delay, 2_147_483_647));
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}

/** Re-read wall time on every wake so background throttling cannot lose time. */
export function watchToolElapsed(onTick: (now: number) => void): () => void {
  const timer = setInterval(() => onTick(Date.now()), 100);
  return () => clearInterval(timer);
}
