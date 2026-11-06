import type { AppSettings, NekkoApi, Session } from '@nekko-agent/shared';

/** Only Mode choices travel to the next chat, never its folders, identity or transcript. */
const MODE_KEYS = [
  'executionMode', 'gitIsolation', 'mode', 'offline', 'cloudOnly', 'incognito',
  'disabledTools', 'workMode', 'effort', 'disabledMcpServers', 'disabledConnectors',
  'memory', 'guidance', 'toolApproach', 'autoModel', 'autoProviderSwitch',
] as const;

/** Keep an explicit unstar across JSON transports, which omit undefined properties. */
export function settingsPatchWithModeReset(patch: Partial<AppSettings>) {
  return Object.hasOwn(patch, 'defaultSavedModeId')
    ? { ...patch, defaultSavedModeId: patch.defaultSavedModeId ?? null }
    : patch;
}

/** Save only fields this action changed, not a stale window's entire mode. */
export async function setChatOptionsAndDefaults(
  api: Pick<NekkoApi, 'setSessionOptions' | 'updateSettings'>,
  id: string,
  patch: Parameters<NekkoApi['setSessionOptions']>[1],
): Promise<Session | null> {
  const next = await api.setSessionOptions(id, patch);
  if (!next) return next;
  const defaults: NonNullable<AppSettings['defaultSessionOptions']> = {};
  for (const key of MODE_KEYS) {
    if (Object.hasOwn(patch, key)) Object.assign(defaults, { [key]: next[key] ?? null });
  }
  // Execution and isolation are one daemon-normalized choice, not independent defaults.
  if (Object.hasOwn(patch, 'executionMode') || Object.hasOwn(patch, 'gitIsolation')) {
    defaults.executionMode = next.executionMode;
    defaults.gitIsolation = next.gitIsolation;
  }
  if (Object.keys(defaults).length) await api.updateSettings({ defaultSessionOptions: defaults });
  return next;
}
