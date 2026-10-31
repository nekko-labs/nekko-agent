import React from 'react';
import type { ChatMessage } from '@nekko-agent/shared';

const RESTART_NOTICE = '_The app closed while this reply was running._\n\n_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._';

/** Match only the host's synthetic notice, never a partial model response. */
export function isRecoveryNotice(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.interrupted === true &&
    !message.toolCalls?.length && !message.reasoning && !message.images?.length &&
    message.content.trim() === RESTART_NOTICE;
}

export function RecoveryNotice() {
  return (
    <div role="note" aria-label="Reply interrupted by app restart" className="my-2 flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-xs text-ink-soft">
      <span aria-hidden="true" className="mt-0.5 text-ink-faint">ⓘ</span>
      <div className="min-w-0">
        <p className="font-medium">Reply interrupted</p>
        <p className="mt-0.5 text-ink-faint">The app closed while this reply was running. Everything above is saved; Continue picks up from here.</p>
      </div>
    </div>
  );
}
