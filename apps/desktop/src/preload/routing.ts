import { IpcEvents } from '@nekko-agent/shared';

/**
 * Where a call goes: every channel goes straight to the engine (nekkod) over
 * its socket, the native ones too (dialogs, the OS shell, the microphone, the
 * updater: crates/nekkod/src/native.rs). Only a few events come from main.
 */

/** Events only main sends. */
export const MAIN_EVENTS = new Set<string>([IpcEvents.deepLink, IpcEvents.voiceStop]);
