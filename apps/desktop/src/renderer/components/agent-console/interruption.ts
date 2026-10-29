import { isContextOverflowError, lastReplyInterrupted, type ChatMessage } from '@nekko-agent/shared';

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
  return {
    // A stop the user asked for, and a run the app's own restart cut off, are
    // not failures and do not wear the failure colour.
    paused: paused || interrupted || overflow,
    reason: detail,
    title: paused ? 'Reply paused' : interrupted ? 'Reply interrupted' : overflow ? 'Out of context' : 'Reply failed',
    detail: `${detail} ${canContinue ? 'The work so far is saved; Retry picks up from here.' : 'No resumable progress was saved. Retry uses the saved conversation.'}`,
  };
}

/** Only retire an inferred transcript warning; real errors remain until dismissed. */
export function reconcileInterruptionNotice(notice: string | null, interrupted: boolean): string | null {
  return notice === PERSISTED_INTERRUPTION && !interrupted ? null : notice;
}


/** A held reply means the final transcript is still loading; the record is stale. */
export function shouldShowPersistedInterruption(history: ChatMessage[], streaming: boolean, awaitingTranscript: boolean, awaitingQuestion = false): boolean {
  return !streaming && !awaitingTranscript && !awaitingQuestion && lastReplyInterrupted(history);
}
