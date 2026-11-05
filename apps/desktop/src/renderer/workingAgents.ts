// Explicit local sends cover prompt latency before the host emits its first token.
const localStarts = new Set<string>();
const localListeners = new Set<(id: string, working: boolean) => void>();

/**
 * Mark a chat as sent to, or its turn as over. A send comes from a chat pane;
 * the end comes from `liveRuns`, which hears it whether or not a pane is open.
 */
export function reportAgentWorking(id: string, working: boolean): void {
  if (working) localStarts.add(id); else localStarts.delete(id);
  for (const listener of localListeners) listener(id, working);
}

/** Chats this window has sent to whose first event has not arrived yet, or is still running. */
export function localAgentStarts(): string[] {
  return [...localStarts];
}

/** Hear this window's sends as they start and end, before the host says anything. */
export function onLocalAgentWorking(listener: (id: string, working: boolean) => void): () => void {
  localListeners.add(listener);
  return () => { localListeners.delete(listener); };
}
