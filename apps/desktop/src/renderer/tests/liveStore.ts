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
  const useStore = Object.assign((select: (s: unknown) => unknown) => select(actual.useStore.getState()), actual.useStore);
  return { ...actual, useStore };
}
