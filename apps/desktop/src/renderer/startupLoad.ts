import { retryUntilAnswered } from './retryUntilAnswered.js';
import { useStore } from './store.js';

/**
 * The first reads of a launch, repeated until the engine answers. Settings come
 * first so the saved provider is restored before the provider list picks a
 * fallback. Returns a stop for effect cleanups.
 */
export function loadStartup(): () => void {
  const store = useStore.getState;
  return retryUntilAnswered(async (retried) => {
    await store().refreshSettings();
    // A rejection with the list in hand is a provider's model list failing: the engine did answer.
    await store().refreshProviders().catch((e: unknown) => { if (!store().providers.length) throw e; });
    if (store().settingsError) throw new Error(store().settingsError ?? undefined);
    if (!retried) return;
    void store().refreshSessions().catch(() => {});
    void store().refreshTerminals().catch(() => {});
    void store().refreshSkills();
  });
}
