import { formatRate } from '@nekko-agent/shared';
import { CheckIcon } from '../../icons.js';
import { MiniNekko } from '../Mascot.js';
import { fmtTok } from './transcript.js';

/** The watch deadline is an upper bound: PR changes may wake the chat sooner. */
export function sleepingLabel(nextWakeAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((nextWakeAt - now) / 60_000));
  const hours = Math.ceil(minutes / 60);
  return `Sleeping · will check in ${minutes > 60 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${minutes} ${minutes === 1 ? 'min' : 'mins'}`}`;
}

/**
 * The live readout while a reply runs, and the chat's state after it. A
 * finished reply's numbers live in the transcript on the reply itself
 * (TurnStatsLine), so once `persisted` is set this row only says what the chat
 * is doing (sleeping, blocked) and repeats no measurements.
 */
export function ReplyStatus({ streaming, status, elapsed, tps, out, last, done, nextWakeAt, now = Date.now(), blocked, estimatedRate = false, persisted = false }: {
  streaming: boolean; status: string; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
  nextWakeAt?: number | null;
  now?: number;
  blocked?: string | null;
  estimatedRate?: boolean;
  /** The last reply's stats are on its message in the transcript. */
  persisted?: boolean;
}) {
  const measured = streaming ? { out, tps, secs: elapsed } : last;
  const sleeping = !streaming && !blocked && nextWakeAt != null;
  // Nothing to say: no run, nothing blocking, no fresh unpersisted numbers.
  const showNumbers = streaming || (!persisted && !!measured);
  const showDone = !streaming && !blocked && !sleeping && !persisted && !!(done || last);
  if (!streaming && !blocked && !sleeping && !showNumbers && !showDone) return null;
  const lead = sleeping ? '' : '· ';
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[12px] text-ink-faint" role="status" data-reply-status>
      {streaming ? (
        <span className="flex items-center gap-2 text-ink-soft"><MiniNekko size={16} /><span className="dots dots-lead -mr-1.5" aria-hidden="true" />{status || 'Working'}</span>
      ) : blocked ? (
        <span>{blocked}</span>
      ) : sleeping ? (
        <span className="basis-full" data-reply-sleeping>{sleepingLabel(nextWakeAt, now)}</span>
      ) : showDone ? (
        <span className="flex items-center gap-1" title={done ?? undefined}><CheckIcon className="h-3 w-3" />Done.</span>
      ) : null}
      {showNumbers && <>
        <span title={estimatedRate ? 'Estimated tokens per second from streamed text and reasoning; replaced by provider usage when available' : 'Output tokens per second while the model was generating'}>{(streaming || blocked || sleeping || done || last) ? lead : ''}{estimatedRate ? '~' : ''}{measured && measured.tps > 0 ? formatRate(measured.tps) : '—'} tok/s</span>
        <span>· {measured ? fmtTok(measured.out) : '—'} total tokens</span>
        <span>· {measured ? `${measured.secs}s` : 'Time unavailable'}</span>
      </>}
    </div>
  );
}
