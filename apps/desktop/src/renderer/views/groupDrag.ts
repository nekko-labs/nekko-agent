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
