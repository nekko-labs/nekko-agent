import { STAR_ASK_START, countStarAskPrompt, markStarAskShown, parseStarAsk, starAskDue, stopStarAsk, type StarAskState } from '@nekko-agent/shared';

/**
 * The in-chat GitHub star ask (spec/platform/github-star-ask.md), remembered in
 * this browser profile only: nothing about it reaches the engine, settings sync
 * or Nekko Labs. Without storage (some private web sessions) it never asks.
 */
const KEY = 'nekko.star-ask';

export function readStarAsk(): StarAskState {
  try { return parseStarAsk(localStorage.getItem(KEY)); } catch { return { ...STAR_ASK_START }; }
}

function write(state: StarAskState): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Storage unavailable: the ask simply never comes. */ }
}

/**
 * A prompt sent from this window got its finished reply. Counts it and says
 * whether that reply carries the card; when it does the ask is used up now, so
 * ignoring the card is the same as Not now.
 */
export function starAskAfterReply(): boolean {
  const counted = countStarAskPrompt(readStarAsk());
  const due = starAskDue(counted);
  write(due ? markStarAskShown(counted) : counted);
  return due;
}

/** Starred, "Don't ask again", or GitHub says it is already starred. */
export function stopStarAsking(): void {
  write(stopStarAsk(readStarAsk()));
}
