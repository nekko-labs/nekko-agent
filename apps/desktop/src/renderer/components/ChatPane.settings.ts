import type { AppSettings } from '@nekko-agent/shared';

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
