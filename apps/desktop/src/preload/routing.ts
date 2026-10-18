import { IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { PICK_FOLDER_CHANNEL } from '../engineChannels.js';

/**
 * Where a call goes. Everything goes straight to the engine over its socket,
 * the native channels too (dialogs, the OS shell, the microphone, the
 * updater: crates/nekkod/src/native.rs). Main answers these only when no
 * daemon runs (`mode: 'backend'`, a checkout without a daemon build).
 */
export const MAIN_FALLBACK = new Set<string>([
  IpcChannels.voicePermission,
  IpcChannels.dialogOpenFiles,
  IpcChannels.openPath,
  IpcChannels.appInfo,
  IpcChannels.updateCheck,
  IpcChannels.updateDownload,
  IpcChannels.updateInstall,
  PICK_FOLDER_CHANNEL,
]);

/** Events only main sends. */
export const MAIN_EVENTS = new Set<string>([IpcEvents.deepLink]);
/** Events either side may send: `update:event` comes from main only without the daemon. */
export const BOTH_EVENTS = new Set<string>([IpcEvents.updateEvent]);

/** Whether `channel` goes to main rather than the engine. */
export async function routeToMain(channel: string, mode: () => Promise<'daemon' | 'backend' | null>): Promise<boolean> {
  return MAIN_FALLBACK.has(channel) && (await mode()) !== 'daemon';
}
