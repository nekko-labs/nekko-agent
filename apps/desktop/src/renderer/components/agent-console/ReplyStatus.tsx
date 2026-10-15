import { formatRate, shortLiveStatus, type LiveActivity } from '@agent-nekko/shared';
import { MiniNekko, type MiniNekkoState } from '../Mascot.js';

export function replyIconState(activity: LiveActivity | undefined): MiniNekkoState {
  const last = activity?.steps[activity.steps.length - 1];
  if (last?.kind === 'tool' && last.status === 'running') {
    const tool = last.label.replace(/^functions\./, '');
    return ['bash', 'start_process', 'read_process', 'kill_process'].includes(tool) ? 'terminal' : 'idle';
  }
  return shortLiveStatus(activity) === 'Thinking' ? 'thinking' : 'idle';
}
import { fmtTok } from './transcript.js';

/**
 * The live subtext under the conversation: while a turn streams it shows
 * elapsed time, throughput, and tokens generated; right after a turn it shows
 * the completion summary; idle, it keeps a muted summary of the last turn.
 * All three render as the same single row, so the transcript's tail never
 * changes height.
 */
export function ReplyStatus({
  streaming, status, elapsed, tps, out, last, done, iconState = 'idle',
}: {
  // `elapsed` is how long the reply has been running; `tps` is the model's decode
  // rate over the time it spent generating, so the two deliberately don't divide
  // into each other (a turn spends much of its wall clock running tools).
  // `status` is the few-word present-tense line: what it is doing, not that it is.
  streaming: boolean; status: string; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
  iconState?: MiniNekkoState;
}) {
  if (streaming) {
    return (
      <div className="fade-in flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[12px] text-ink-faint">
        <span className="flex items-center gap-2 text-ink-soft"><MiniNekko size={16} state={iconState} /> {status || 'Working'}<span className="dots" /></span>
        {elapsed > 0 && <span>· {elapsed}s</span>}
        {tps > 0 && <span title="Output tokens per second while the model was generating">· {formatRate(tps)} tok/s</span>}
        {out > 0 && <span>· {fmtTok(out)} tokens</span>}
      </div>
    );
  }
  if (done) {
    return (
      <div className="fade-in flex items-center gap-2 pt-1 text-[12px]" style={{ color: 'var(--success)' }} role="status">
        <span>✓</span> {done}
      </div>
    );
  }
  if (last && last.out > 0) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[11px] text-ink-faint/80">
        <span>Last reply</span>
        <span>· {fmtTok(last.out)} tokens</span>
        {last.tps > 0 && <span title="Output tokens per second while the model was generating">· {formatRate(last.tps)} tok/s</span>}
        {last.secs > 0 && <span>· {last.secs}s</span>}
      </div>
    );
  }
  return null;
}
