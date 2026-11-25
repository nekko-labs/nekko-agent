import type { ChatMessage } from '@nekko-agent/shared';

/** How far the engine's clock may trail the window's when it stamps a saved prompt. */
const CLOCK_SLACK_MS = 60_000;

/**
 * A prompt this pane sent that the saved chat does not have yet, or null.
 *
 * A turn saves its prompt only once it starts, and a Claude Agent turn waits
 * for the chat's Claude Code first (a wake-up turn may hold it for minutes).
 * Every re-read of the chat meanwhile replaced the pane's optimistic copy, so
 * the prompt went missing until its turn began. It stays on screen until a
 * saved user message with the same text, sent no earlier, takes its place.
 */
export function unsavedPrompt(saved: ChatMessage[], sent: ChatMessage | null): ChatMessage | null {
  if (!sent) return null;
  const landed = saved.some((m) => m !== sent && m.role === 'user' && m.content === sent.content && m.createdAt >= sent.createdAt - CLOCK_SLACK_MS);
  return landed ? null : sent;
}

/** The transcript on screen, ending with the unsaved prompt when it has dropped out. */
export function withUnsavedPrompt(shown: ChatMessage[], unsaved: ChatMessage | null): ChatMessage[] {
  return unsaved && !shown.includes(unsaved) ? [...shown, unsaved] : shown;
}
