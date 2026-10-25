import { formatRate, shortLiveStatus, type LiveActivity } from '@nekko-agent/shared';
import { CheckIcon } from '../../icons.js';
import { MiniNekko } from '../Mascot.js';
import { fmtTok } from './transcript.js';

export type ReplyIconState = 'idle' | 'thinking' | 'terminal';

/** Tools whose running time is spent in a shell. */
const TERMINAL_TOOLS = new Set(['bash', 'start_process', 'read_process', 'kill_process']);

/**
 * Which picture leads the live status: a terminal while a shell tool runs, a
 * thought bubble while the model thinks, and Nekko for everything else
 * (other tools, writing the reply, starting up).
 */
export function replyIconState(activity: LiveActivity | undefined): ReplyIconState {
  const last = activity?.steps[activity.steps.length - 1];
  if (last?.kind === 'tool' && last.status === 'running') {
    return TERMINAL_TOOLS.has(last.label.replace(/^functions\./, '')) ? 'terminal' : 'idle';
  }
  return shortLiveStatus(activity) === 'Thinking' ? 'thinking' : 'idle';
}

/** The 16px icon before the live status text. Decorative; the text says the same. */
export function ReplyActivityIcon({ state, size = 16, stationary = false }: { state: ReplyIconState; size?: number; stationary?: boolean }) {
  if (state === 'idle') return <MiniNekko size={size} />;
  return (
    <span className="reply-activity-icon inline-block shrink-0 align-middle" data-reply-icon={state} style={{ lineHeight: 0 }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'terminal' ? (
          <g data-part="reply-terminal">
            <rect x="3" y="5" width="26" height="23" rx="2" />
            <path d="M3 11H29 M7 8H8 M11 8H12" />
            <svg x="6" y="14" width="20" height="11" viewBox="0 0 20 11" overflow="hidden">
              <g className={stationary ? undefined : 'reply-terminal-lines'} strokeWidth="1.5">
                <path d="M0 2L2 3.5L0 5 M5 4H13 M0 9H17 M0 14H10 M0 19H15 M0 24H13" />
              </g>
            </svg>
          </g>
        ) : (
          <g data-part="reply-thought">
            <circle className="reply-thought-dot" cx="5" cy="27" r="1" fill="currentColor" stroke="none" />
            <circle className="reply-thought-dot" cx="9" cy="23" r="1.8" style={{ animationDelay: '180ms' }} />
            <g className="reply-thought-bubble">
              <path d="M10 18C3 18 3 9 9 8C9 2 18 1 21 6C29 4 32 14 26 17C24 23 14 23 10 18Z" />
              {[13, 18, 23].map((x, i) => <circle key={x} className="reply-thought-dot" cx={x} cy="13" r="1" fill="currentColor" stroke="none" style={{ animationDelay: `${i * 180}ms` }} />)}
            </g>
          </g>
        )}
      </svg>
    </span>
  );
}

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
export function ReplyStatus({ streaming, status, elapsed, tps, out, last, done, nextWakeAt, now = Date.now(), blocked, estimatedRate = false, persisted = false, iconState = 'idle' }: {
  streaming: boolean; status: string; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
  nextWakeAt?: number | null;
  now?: number;
  blocked?: string | null;
  estimatedRate?: boolean;
  /** The last reply's stats are on its message in the transcript. */
  persisted?: boolean;
  /** What the live run is doing, for the icon; see `replyIconState`. */
  iconState?: ReplyIconState;
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
        <span className="flex items-center gap-2 text-ink-soft"><ReplyActivityIcon state={iconState} /><span className="dots dots-lead -mr-1.5" aria-hidden="true" />{status || 'Working'}</span>
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
