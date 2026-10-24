/**
 * A chat as the app's lists see it: every field of the session except its
 * transcript, plus the handful of facts those lists used to dig out of the
 * transcript themselves.
 *
 * `listSessions` used to hand the renderer every message of every chat on each
 * refresh, which is megabytes over IPC and a full JSON parse per chat, all to
 * draw a sidebar. The sidebar, the Agent board board, the sub-agent rail and
 * the insights need a count, a first prompt, a last reply and a few turns, so
 * the host works those out once, when a chat is written, and lists ship this
 * instead. A chat's full transcript is still one `getSession` away.
 */

import type { ChatMessage, Session } from './chat.js';
import { estimateTranscriptTokens } from './context.js';
import { collectSessionPrUrls } from './pr.js';
import { isStalled, recentTurns, type TurnExcerpt } from './session-board.js';

/** Turns a summary keeps: the most an Agent board card shows expanded. */
export const SUMMARY_TURNS = 8;
/** Longest excerpt a summary carries per turn; longer ones end in an ellipsis. */
export const SUMMARY_TURN_CHARS = 4_000;
/** The first prompt is kept this long, which is plenty to tell what a chat is for. */
const FIRST_PROMPT_CHARS = 2_000;
const LAST_REPLY_CHARS = 200;

/** A session's own fields, which a summary and a full session both carry. */
export type SessionMeta = Omit<Session, 'messages'>;

export interface SessionSummary extends SessionMeta {
  /** Messages in the transcript, every role included. */
  messageCount: number;
  /** User and assistant messages only: the exchange a card counts. */
  exchangeCount: number;
  /** The first user message (capped): what the chat was started to do. */
  firstUserText?: string;
  /** The newest non-empty assistant reply, whitespace folded and capped. */
  lastReplyText?: string;
  /** When the newest assistant message landed. */
  lastReplyAt?: number;
  /** Estimated tokens the transcript takes when replayed to the model. */
  transcriptTokens: number;
  /** The last reply was cut off part-way and nothing has resumed it. */
  stalled: boolean;
  /** The last few turns, newest last, as a card shows them. */
  recentTurns: TurnExcerpt[];
  /** Pull requests referenced anywhere in the chat (text or tool output). */
  prUrls: string[];
  /** Pictures an image chat has made. */
  imageCount: number;
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Work a session's summary out of its transcript. */
export function summarizeSession(session: Session): SessionSummary {
  const { messages, ...rest } = session;
  let exchangeCount = 0;
  let firstUser: ChatMessage | undefined;
  let lastReply: ChatMessage | undefined;
  let lastReplyAt: number | undefined;
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') exchangeCount++;
    if (!firstUser && m.role === 'user') firstUser = m;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (lastReplyAt === undefined) lastReplyAt = m.createdAt;
    if (m.content.trim()) { lastReply = m; break; }
  }
  return {
    ...rest,
    messageCount: messages.length,
    exchangeCount,
    ...(firstUser ? { firstUserText: cap(firstUser.content, FIRST_PROMPT_CHARS) } : {}),
    ...(lastReply ? { lastReplyText: cap(lastReply.content.trim().replace(/\s+/g, ' '), LAST_REPLY_CHARS) } : {}),
    ...(lastReplyAt !== undefined ? { lastReplyAt } : {}),
    transcriptTokens: estimateTranscriptTokens(messages),
    stalled: isStalled(messages),
    recentTurns: recentTurns(messages, SUMMARY_TURNS).map((t) => ({ ...t, text: cap(t.text, SUMMARY_TURN_CHARS) })),
    prUrls: collectSessionPrUrls(messages),
    imageCount: messages.reduce((n, m) => n + (m.role === 'assistant' && m.generated ? m.images?.length ?? 0 : 0), 0),
  };
}
