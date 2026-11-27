/** Insert a project before a peer, or at the end. Invalid/self drops are no-ops. */
export function moveGroupBefore(ids: string[], moved: string, before: string | null): string[] {
  if (!ids.includes(moved) || moved === before || (before !== null && !ids.includes(before))) return ids;
  const rest = ids.filter(id => id !== moved);
  rest.splice(before === null ? rest.length : rest.indexOf(before), 0, moved);
  return rest;
}

/** Child-boundary dragleave events do not mean the pointer left the group. */
export function leftGroup(current: HTMLElement, related: EventTarget | null): boolean {
  return !related || !current.contains(related as Node);
}

/**
 * Drag-overs an inner drop target has taken. An inner target must not stop the
 * event: the dragged chip follows the pointer from a document-level dragover
 * listener, which then stops hearing it and leaves the chip stuck. It claims the
 * event here instead, and the targets around it leave a claimed one alone.
 */
const claimedDragOvers = new WeakSet<object>();

export function claimDragOver(e: { nativeEvent: object }): void {
  claimedDragOvers.add(e.nativeEvent);
}

export function dragOverClaimed(e: { nativeEvent: object }): boolean {
  return claimedDragOvers.has(e.nativeEvent);
}
