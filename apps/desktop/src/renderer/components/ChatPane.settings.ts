import { AUTO_MODEL_ID } from '@nekko-agent/shared';
import type { AppSettings, Session } from '@nekko-agent/shared';

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
    localCostBenchmark: settings.localCostBenchmark,
    favoriteModels: settings.favoriteModels,
    prompts: settings.prompts,
    workspaces: settings.workspaces,
    defaultChatMode: settings.defaultChatMode,
  };
}

/** Saved defaults belong together; a session's own choice always wins. */
export function initialChatBrain(session: Session | null | undefined, state: {
  settings: AppSettings | null; activeProviderId: string | null; activeModelId: string | null; providers: { id: string }[];
}): { providerId: string | null; modelId: string | null } {
  const own = !!session?.providerId;
  const saved = !own && !!state.settings?.defaultProviderId;
  return {
    providerId: session?.providerId ?? state.settings?.defaultProviderId ?? state.activeProviderId ?? state.providers[0]?.id ?? null,
    modelId: session?.autoModel ? AUTO_MODEL_ID : session?.modelId ?? (own ? null : saved ? state.settings?.defaultModelId ?? null : state.activeModelId),
  };
}
