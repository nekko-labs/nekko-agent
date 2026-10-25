/**
 * Opt-in usage and crash reports (crates/nekkod/src/telemetry.rs). The words
 * shown wherever someone is asked, so onboarding and Settings promise the same.
 */
export const TELEMETRY_PROMISES = [
  'Off unless you turn it on. Turn it off any time in Settings.',
  'Anonymous: a random id, the app version and your OS. No name, email, IP location or account.',
  'Never your chats, prompts, files, folder names or model replies.',
  'Error reports are scrubbed of secrets, personal details and file paths.',
  'Never sold or shared. Used only to fix bugs and decide what to build.',
];

/** The settings once someone turns reports on or off. A new id each time it is turned on. */
export function telemetryChoice(on: boolean): { enabled: boolean; installId?: string } {
  return on ? { enabled: true, installId: crypto.randomUUID() } : { enabled: false };
}
