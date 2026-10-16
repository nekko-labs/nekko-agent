import type { ChatMessage } from '@nekko-agent/shared';

/**
 * Where the transcript is cut for the two "take it back" actions, as the id
 * `truncateSession` drops from (that message and everything after it), with
 * how many messages go. Pure, so the rows can be told up front which of them
 * carry a button and the pane can say exactly what a click removes.
 *
 * - **Restart from here** sits on the last reply of a turn that has anything
 *   after it, and keeps the conversation up to and including that reply.
 * - **Delete** sits on the latest user message only, and removes it with the
 *   reply it got: the way out of a message the model cannot take (a picture
 *   to a text-only model), without losing the rest of the chat.
 */
export interface MessageCut {
  /** First message removed; `truncateSession(session, from)` drops it and the rest. */
  from: string;
  /** Messages removed, the reply's tool calls and results included. */
  removed: number;
}

export interface MessageCuts {
  /** Reply id -> the cut a Restart from here on it makes. */
  restart: Map<string, MessageCut>;
  /** The latest user message and the cut deleting it makes, if there is one. */
  deleteLast: { id: string; cut: MessageCut } | null;
}

/** Messages that are shown as a reply a person would restart from. */
function isReply(m: ChatMessage): boolean {
  return m.role === 'assistant' && !m.compaction && !!(m.content.trim() || m.images?.length);
}

export function messageCuts(messages: ChatMessage[]): MessageCuts {
  const restart = new Map<string, MessageCut>();
  let lastReply = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      // The turn before this message ended; its last reply may restart here.
      if (lastReply >= 0) restart.set(messages[lastReply].id, { from: m.id, removed: messages.length - i });
      lastReply = -1;
    } else if (isReply(m)) {
      lastReply = i;
    } else if (m.compaction) {
      // A summary stands in for what came before it: nothing behind it restarts past it.
      lastReply = -1;
    }
  }
  let deleteLast: MessageCuts['deleteLast'] = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.compaction) break;
    if (m.role === 'user') {
      deleteLast = { id: m.id, cut: { from: m.id, removed: messages.length - i } };
      break;
    }
  }
  return { restart, deleteLast };
}

/** The confirmation a cut asks for, in plain words. */
export function cutPrompt(kind: 'restart' | 'delete', cut: MessageCut): string {
  if (kind === 'delete') {
    const rest = cut.removed - 1;
    return rest > 0
      ? `Delete your last message and the ${rest === 1 ? 'reply' : `${rest} messages`} after it? This can't be undone.`
      : "Delete your last message? This can't be undone.";
  }
  return `Restart from this reply? The ${cut.removed === 1 ? 'message' : `${cut.removed} messages`} after it will be deleted. This can't be undone.`;
}
