import { isContextOverflowError, lastReplyInterrupted, type ChatMessage, type Session } from '@nekko-agent/shared';

/**
 * The notice for a reply the chat found already cut off in its transcript: the
 * app was closed or the host restarted while it ran, so no `error` event ever
 * reached the pane (see `lastReplyInterrupted`).
 */
export const PERSISTED_INTERRUPTION = 'This reply was interrupted before it finished.';

export function describeInterruption(message: string, canContinue: boolean) {
  const paused = message === 'Stopped';
  const interrupted = message === PERSISTED_INTERRUPTION;
  const overflow = !paused && !interrupted && isContextOverflowError(message);
  const detail = paused
    ? 'You stopped this reply.'
    : overflow
      ? 'The conversation outgrew the model\'s context window. Nekko Agent compacts it and carries on by itself; this stays only if that could not happen.'
      : /^terminated\.?$/i.test(message.trim())
        ? 'The response stream ended unexpectedly. The provider did not report a specific cause.'
        : message;
  const signInExpired = !paused && !interrupted && !overflow && isAuthError(message);
  return {
    // A stop the user asked for, and a run the app's own restart cut off, are
    // not failures and do not wear the failure colour.
    paused: paused || interrupted || overflow,
    signInExpired,
    reason: detail,
    title: paused ? 'Reply paused' : interrupted ? 'Reply interrupted' : overflow ? 'Out of context' : signInExpired ? 'Sign-in expired' : 'Reply failed',
    detail: `${detail} ${canContinue ? 'The work so far is saved; Retry picks up from here.' : 'No resumable progress was saved. Retry uses the saved conversation.'}`,
  };
}

/**
 * What "Ask parent to resume" sends the parent of a Claude Code subagent that
 * stopped: only the parent's Claude Code can wake it, so the subagent's own
 * chat never retries (it is a copy to watch).
 */
export function subagentResumeRequest(title: string | undefined, failure: string): string {
  const name = title?.trim() ? `The subagent "${title.trim()}"` : 'A subagent';
  return `${name} stopped before it finished: ${failure.trim()}\n\nResume it so it carries on from where it stopped.`;
}

/**
 * Whether a failed reply was refused for its credentials (an expired or revoked
 * sign-in, a bad key), which only signing in again fixes. Providers report it as
 * "<provider> 401: {...}" with codes like token_expired or invalid_api_key.
 */
export function isAuthError(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|token_expired|invalid_api_key|authentication_error|sign(ing)? in again/i.test(message);
}

/** Only retire an inferred transcript warning; real errors remain until dismissed. */
export function reconcileInterruptionNotice(notice: string | null, interrupted: boolean): string | null {
  return notice === PERSISTED_INTERRUPTION && !interrupted ? null : notice;
}


/** The saved failure of the turn that ended this transcript; anything newer retires it. */
export function savedTurnFailure(session: Pick<Session, 'messages' | 'turnFailure'>): string | null {
  const failure = session.turnFailure;
  return failure && failure.afterMessageId === session.messages.at(-1)?.id ? failure.message : null;
}

/** A held reply means the final transcript is still loading; the record is stale. */
export function shouldShowPersistedInterruption(history: ChatMessage[], streaming: boolean, awaitingTranscript: boolean, awaitingQuestion = false): boolean {
  return !streaming && !awaitingTranscript && !awaitingQuestion && lastReplyInterrupted(history);
}

/**
 * A usage limit's reset time for the Continue button: the time alone today,
 * with the weekday within a week, with the date after that.
 */
export function formatResetTime(at: number, now: number, locale?: string): string {
  const time = new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  const day = at - now < 6 * 24 * 60 * 60_000
    ? new Date(at).toLocaleDateString(locale, { weekday: 'short' })
    : new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}
