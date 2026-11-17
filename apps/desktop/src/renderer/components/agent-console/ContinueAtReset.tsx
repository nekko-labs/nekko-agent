import React from 'react';
import { formatResetTime } from './interruption.js';

/**
 * The Reply failed notice's "Continue at <time>" for a used-up usage limit
 * with a known reset (#2811), or, once pressed, when it will continue and a
 * way to call that off. nekkod holds the schedule (`limit_resume.rs`), so it
 * happens with the pane, or the window, closed.
 */
export function ContinueAtReset({ resetAt, armedAt, now, onSchedule }: {
  /** When the limit resets, if this failure is one and the time is known. */
  resetAt: number | null;
  /** The saved schedule (`turnFailure.continueAt`). */
  armedAt: number | null;
  now: number;
  /** Save a schedule, or drop it with null. */
  onSchedule: (at: number | null) => void;
}) {
  if (armedAt) {
    return (
      <span data-continue-armed className="flex items-center gap-2 text-ink-soft">
        Continues by itself at {formatResetTime(armedAt, now)}.
        <button className="btn btn-outline shrink-0 px-3 py-0.5 text-2xs"
          title="Keep the notice and Retry, but don't continue when the limit resets"
          onClick={() => onSchedule(null)}>
          Don't continue
        </button>
      </span>
    );
  }
  if (!resetAt) return null;
  const when = formatResetTime(resetAt, now);
  return (
    <button className="btn btn-outline shrink-0 px-3 py-0.5 text-2xs" data-continue-at-reset
      title={`Retry by itself a minute after the usage limit resets (${when}), even with the window closed. You get a reminder when it does.`}
      onClick={() => onSchedule(resetAt)}>
      Continue at {when}
    </button>
  );
}
