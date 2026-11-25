/**
 * A store selector for a list that keeps the previous array while its entries
 * are the same objects, for components that read a few chats out of the session
 * list. It uses no hooks, so it works as a plain selector:
 * `useStore((s) => childrenOf(s, id))` re-renders only when an entry of the
 * result is replaced, added or removed.
 *
 * `refreshSessions` keeps an unchanged chat's object (see `reuseSessions`), so
 * "the same objects" is what "nothing I show changed" means. Each distinct
 * `key` (a chat id, say) keeps its own last result; the oldest keys are dropped
 * past 256.
 */
export function stableSelector<S, T>(compute: (state: S, key: string) => T[]): (state: S, key?: string) => T[] {
  const last = new Map<string, T[]>();
  return (state, key = '') => {
    const next = compute(state, key);
    const prev = last.get(key);
    if (prev && prev.length === next.length && prev.every((x, i) => x === next[i])) return prev;
    last.delete(key);
    last.set(key, next);
    if (last.size > 256) last.delete(last.keys().next().value!);
    return next;
  };
}
