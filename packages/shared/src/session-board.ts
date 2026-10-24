/**
 * Which column a chat belongs in on the Agent board board.
 *
 * The board replaced two lists that answered the same question badly: "Now"
 * showed what was running, "Sessions" showed everything else in one flat pile,
 * and neither said the thing you actually open the app to find out — which of
 * these is waiting on *me*. A run that stopped to ask a question looked exactly
 * like a run that finished.
 *
 * So the lanes are derived from state, never assigned: there is nothing to drag
 * because a card's column is a fact about the chat, not a label someone put on
 * it. Move the work and the card moves itself.
 */

import type { ChatMessage, PendingInput } from './chat.js';

export type SessionLane = 'needs-you' | 'working' | 'idle';

export const SESSION_LANES: SessionLane[] = ['needs-you', 'working', 'idle'];

export const LANE_META: Record<SessionLane, { title: string; blurb: string; tone: string }> = {
  'needs-you': {
    title: 'Needs you',
    blurb: 'Blocked until you answer',
    tone: 'var(--warning)',
  },
  working: {
    title: 'Working',
    blurb: 'Running right now',
    tone: 'var(--success)',
  },
  idle: {
    title: 'Idle',
    blurb: 'Nothing pending',
    tone: 'var(--ink-faint)',
  },
};

/** What, specifically, a "needs you" card is blocked on. */
export type BlockedReason = 'question' | 'approval' | 'interrupted';

export const BLOCKED_META: Record<BlockedReason, { label: string; icon: string }> = {
  question: { label: 'Asked you a question', icon: '💬' },
  approval: { label: 'Waiting for approval', icon: '🔒' },
  interrupted: { label: 'Stopped part-way', icon: '⏸' },
};

/**
 * Did this run stop part-way and stay that way?
 *
 * An interrupted reply is the quietest failure the app has: the transcript
 * simply ends, and unless you open the chat you never learn it did not finish.
 * On the board it is a card that needs you, because resuming it is a decision
 * only you can make.
 */
export function isStalled(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'assistant' && !!last.interrupted;
}

/** The lane a chat sits in, and why when the answer is "it needs you". */
export function sessionLane(input: {
  running: boolean;
  pending?: PendingInput;
  /** The transcript, or, from a summary, whether it already ends stalled. */
  messages?: ChatMessage[];
  stalled?: boolean;
}): { lane: SessionLane; blocked?: BlockedReason } {
  if (input.pending?.question) return { lane: 'needs-you', blocked: 'question' };
  if (input.pending?.approval) return { lane: 'needs-you', blocked: 'approval' };
  // Running outranks a stalled *earlier* turn: a chat that is working again has
  // moved past whatever stopped it, and reading it as blocked would park a live
  // agent in a lane that asks the user to do something about it.
  if (input.running) return { lane: 'working' };
  if (input.stalled ?? isStalled(input.messages ?? [])) return { lane: 'needs-you', blocked: 'interrupted' };
  return { lane: 'idle' };
}

/**
 * How long a card has been waiting on a person, or 0 when it is not.
 * Lanes sort on this so the thing that has been blocked longest is at the top,
 * which is the opposite of every other list in the app and correct here.
 */
export function waitingSince(pending: PendingInput | undefined): number {
  return pending?.question?.askedAt ?? pending?.approval?.requestedAt ?? 0;
}

/** One side of the exchange, as a card shows it. */
export interface TurnExcerpt {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /** The reply this came from was cut off part-way. */
  interrupted?: boolean;
  /** An image-chat reply: the picture itself is fetched on demand (`sessionImages`). */
  image?: { width: number; height: number; seed: number };
}

/**
 * The tail of the conversation, as the back-and-forth it was.
 *
 * A card used to show one clamped paragraph of the last assistant message,
 * which is the half of the exchange you already know the least about: without
 * the instruction above it, a reply reads as a non-sequitur. So both sides come
 * back, newest last, with the working steps dropped — an assistant message that
 * only called tools said nothing, and the rail above covers what it did.
 */
export function recentTurns(messages: ChatMessage[], limit: number): TurnExcerpt[] {
  const out: TurnExcerpt[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = m.content.trim();
    const g = m.role === 'assistant' && m.images?.length ? m.generated : undefined;
    if (!text && !g) continue;
    out.push({
      id: m.id,
      role: m.role,
      text: text || (g ? `${g.width}×${g.height} image` : ''),
      at: m.createdAt,
      ...(m.interrupted ? { interrupted: true } : {}),
      ...(g ? { image: { width: g.width, height: g.height, seed: g.seed } } : {}),
    });
  }
  return out.reverse();
}
