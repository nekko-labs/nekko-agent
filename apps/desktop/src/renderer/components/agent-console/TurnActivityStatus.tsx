import { useEffect, useState } from 'react';
import { shortLiveStatus } from '@nekko-agent/shared';
import type { LiveRun } from '../../liveRuns.js';
import { usePaneVisible } from '../../paneVisibility.js';
import { isRunningTool } from './toolProgress.js';
import { fmtElapsed } from './ActivityGroup.js';

/** Report observed state, not a guess that a quiet provider is hung. */
export function turnActivityLabel(run: LiveRun, pendingCallId?: string): string {
  if (pendingCallId) return 'Waiting for your approval';
  if (shortLiveStatus(run.activity) === 'Paused') return 'Paused until this computer is free';
  if (run.retrying) return 'Waiting to retry the model';
  const items = run.blocks.flatMap(block => block.kind === 'activity' ? block.items : []);
  const running = items.filter(item => isRunningTool(item));
  if (running.length) return `Running ${running.length} tool${running.length === 1 ? '' : 's'}`;
  if (run.reasoningStartedAt) return 'Thinking';
  if (run.generation) return 'Model responding';
  return run.tools.length ? 'Tools finished · Waiting for the model' : 'Waiting for the model';
}

/** Outside collapsible steps, and absent once the turn actually finishes. */
export function TurnActivityStatus({ run, pendingCallId }: { run: LiveRun; pendingCallId?: string }) {
  const visible = usePaneVisible();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, run.startedAt]);
  return <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint" data-turn-activity>
    <span className="font-medium text-ink-soft">{turnActivityLabel(run, pendingCallId)}</span>
    <span className="tabular-nums">· Turn elapsed {fmtElapsed(Math.max(0, now - run.startedAt))}</span>
    <span className="basis-full text-2xs">Tool times measure individual calls, not the whole reply.</span>
  </div>;
}
