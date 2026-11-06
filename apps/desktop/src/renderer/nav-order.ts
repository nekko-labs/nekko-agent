export function navOrder<T extends string>(all: readonly T[], saved?: readonly string[]): T[] {
  return [...new Set([...(Array.isArray(saved) ? saved.filter((v): v is T => all.includes(v as T)) : []), ...all])];
}

export function moveNav<T extends string>(order: readonly T[], from: T, to: T): T[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return [...order];
  const next = [...order];
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}

/** Hiding a shortcut never disables the destination itself. */
export function sidebarViewVisible(view: string, preferences?: { skills?: boolean; connectors?: boolean }): boolean {
  return view === 'skills' || view === 'connectors' ? preferences?.[view] === true : true;
}
