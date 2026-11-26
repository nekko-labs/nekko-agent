/**
 * Group and tag choices made in a new chat's composer. A chat with no messages
 * is not a chat yet: saving a group or tags on it would put a card in the
 * sidebar and a breadcrumb in the header, changing the new-chat screen. So the
 * choice is held here, keyed by chat id, and saved when the first message is sent.
 */

export type HeldPatch = { chatGroup?: string | null; tags?: string[] };

const held = new Map<string, HeldPatch>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; listeners.forEach((l) => l()); };

export const subscribeHeld = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const heldVersion = () => version;

export const getHeld = (id: string): HeldPatch | undefined => held.get(id);
export const hasHeld = (id: string): boolean => held.has(id);

export function holdChoice(id: string, patch: HeldPatch): void {
  held.set(id, { ...held.get(id), ...patch });
  changed();
}

/** Forget a chat's held choice (the chat was discarded, or it was applied). Returns what was held. */
export function takeHeld(id: string): HeldPatch | undefined {
  const patch = held.get(id);
  if (held.delete(id)) changed();
  return patch;
}

/** A chat with no messages holds its choices instead of saving them; one that is not in the list yet does too. */
export const isUnsent = (summary: { messageCount: number } | undefined): boolean => !summary || summary.messageCount === 0;

/** The chat as the picker and button read it: with a hold, a held choice shows over what is saved. */
export function chatWithHeld(id: string, summary: { chatGroup?: string | null; tags?: string[] | null } | undefined, hold: boolean) {
  const h = !summary || hold ? held.get(id) : undefined;
  return {
    id,
    exists: Boolean(summary),
    chatGroup: h && 'chatGroup' in h ? h.chatGroup : summary?.chatGroup,
    tags: h?.tags ?? summary?.tags,
  };
}

/** Held choices whose chat has now sent a message: these are saved, once. */
export function heldReadyToApply(ids: ReadonlyArray<string>, sessions: ReadonlyArray<{ id: string; messageCount: number }>): string[] {
  return ids.filter((id) => held.has(id) && sessions.some((s) => s.id === id && s.messageCount > 0));
}
