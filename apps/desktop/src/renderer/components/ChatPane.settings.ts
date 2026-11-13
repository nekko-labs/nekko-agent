import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import type { AppSettings, ProviderConfig, Session } from '@nekko-agent/shared';
import { providerConnected } from './providers/providerSetup.js';

/**
 * The settings a chat window reads, and nothing else. Selected with
 * `useShallow`, so a window re-renders only when one of these changes. The
 * whole settings object is replaced on every save, and the wall saves itself
 * there a moment after each switch: subscribed to all of it, every chat window
 * on the wall (a dozen, each with its composer) re-rendered after every switch.
 */
export function chatPaneSettings(settings: AppSettings | null | undefined) {
  if (!settings) return null;
  return {
    themePreset: settings.themePreset,
    backgroundAnimation: settings.backgroundAnimation,
    localCostBenchmark: settings.localCostBenchmark,
    favoriteModels: settings.favoriteModels,
    fusion: settings.fusion,
    prompts: settings.prompts,
    workspaces: settings.workspaces,
    defaultChatMode: settings.defaultChatMode,
    mascotEnabled: settings.mascotEnabled,
  };
}

type BrainState = {
  settings: AppSettings | null;
  activeProviderId: string | null;
  activeModelId: string | null;
  providers: Pick<ProviderConfig, 'id' | 'kind' | 'enabled'>[];
  models: { id: string }[];
};

/**
 * With nothing saved, the active provider is often just startup's `providers[0]`:
 * keep it while it is connected, otherwise open on one that is.
 */
function fallbackProviderId(state: BrainState): string | null {
  const active = state.providers.find((p) => p.id === state.activeProviderId);
  if (active && providerConnected(active, state.activeModelId ?? state.models[0]?.id)) return active.id;

  return state.providers.find((p) => providerConnected(p))?.id ?? state.activeProviderId ?? state.providers[0]?.id ?? null;
}

/** Saved defaults belong together; a session's own choice always wins. */
export function initialChatBrain(session: Session | null | undefined, state: BrainState): { providerId: string | null; modelId: string | null } {
  const own = !!session?.providerId;
  const saved = !own && !!state.settings?.defaultProviderId;
  const providerId = session?.providerId ?? state.settings?.defaultProviderId ?? fallbackProviderId(state);

  // The active model belongs to the active provider, and goes no further.
  const fallbackModelId = providerId === state.activeProviderId ? state.activeModelId : null;

  return {
    providerId,
    modelId: session?.autoModel ? AUTO_MODEL_ID : session?.modelId ?? (own ? null : saved ? state.settings?.defaultModelId ?? null : fallbackModelId),
  };
}
