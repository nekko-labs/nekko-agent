import type { VoiceEngine, VoiceSettings, VoiceStatus } from '@nekko-agent/shared';

/** One row of the System models list: a speech engine and the one action it offers. */
export interface EngineRow {
  id: VoiceEngine;
  name: string;
  detail: string;
  active: boolean;
  installed: boolean;
  installing: boolean;
  /** Install or remove is possible; Apple's is hidden off macOS and when the OS has no model. */
  action: 'install' | 'remove' | null;
  error?: string;
}

/** The rows for the current status: Apple's recognizer only where the helper answered. */
export function engineRows(status: VoiceStatus | null, voice: VoiceSettings = {}): EngineRow[] {
  if (!status) return [];
  const active = voice.enabled ? status.engine : null;
  const rows: EngineRow[] = [];
  const apple = status.apple;
  if (apple.supported || apple.reason) {
    rows.push({
      id: 'apple',
      name: 'Apple speech',
      detail: apple.supported
        ? `On-device, built into macOS · ${apple.locale ?? 'this language'}${apple.installed ? ' ready' : ' needs its language pack'}`
        : apple.reason ?? 'Unavailable',
      active: active === 'apple',
      installed: apple.installed,
      installing: apple.installing,
      action: !apple.supported ? null : apple.installed ? 'remove' : 'install',
      error: apple.error,
    });
  }
  const whisper = status.whisper;
  rows.push({
    id: 'whisper',
    name: 'Whisper Tiny English',
    detail: status.supported
      ? `Nekko Voice · about 32 MB plus the CPU runtime${whisper.installing ? ` · downloading ${Math.round(whisper.progress * 100)}%` : whisper.installed ? ' · downloaded' : ''}`
      : 'No verified speech server for this platform; set a custom whisper-server path below.',
    active: active === 'whisper',
    installed: whisper.installed,
    installing: whisper.installing,
    action: whisper.installed ? 'remove' : status.supported ? 'install' : null,
    error: whisper.error,
  });
  return rows;
}
