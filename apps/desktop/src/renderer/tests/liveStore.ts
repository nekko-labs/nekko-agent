/**
 * A `vi.mock` factory for `store.js` that keeps the real store but makes the
 * hook read its current state. React's server renderer reads zustand's
 * *initial* state (its server snapshot), so without this a test's `setState`
 * would not show in `renderToStaticMarkup`.
 *
 *   import { liveStore } from '../tests/liveStore.js';
 *   vi.mock('../store.js', (original) => liveStore(original));
 *
 * Import it before anything that imports the store.
 */
export async function liveStore<T extends { useStore: { getState: () => unknown } }>(original: () => Promise<T>): Promise<T> {
  const actual = await original();
  return { ...actual, useStore: live(actual.useStore) };
}

/** The same, for any zustand hook exported by a module (e.g. `useWallLogs` from `wallLogs.js`). */
export function liveHook<K extends string>(name: K) {
  return async <T extends Record<K, { getState: () => unknown }>>(original: () => Promise<T>): Promise<T> => {
    const actual = await original();
    return { ...actual, [name]: live(actual[name]) };
  };
}

function live<H extends { getState: () => unknown }>(hook: H): H {
  return Object.assign((select: (s: unknown) => unknown = (s) => s) => select(hook.getState()), hook);
}
