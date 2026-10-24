export type VoiceEngine = 'apple' | 'whisper';

export interface VoiceSettings {
  enabled?: boolean;
  /** Which recognizer dictation runs on; unset means Apple's where it is supported, else Whisper. */
  engine?: VoiceEngine;
  modelPath?: string;
  runtimePath?: string;
  language?: string;
  deviceId?: string;
  /** 0–100; higher values detect quieter speech. */
  sensitivity?: number;
  silenceMs?: number;
  commandsEnabled?: boolean;
  threads?: number;
  idleSeconds?: number;
}
/** `installed`, `installing` and `error` speak for the active engine; `apple` and `whisper` for each. */
export interface VoiceStatus {
  installed: boolean;
  installing: boolean;
  progress: number;
  running: boolean;
  modelPath?: string;
  runtimePath?: string;
  error?: string;
  supported: boolean;
  engine: VoiceEngine;
  apple: { supported: boolean; installed: boolean; installing: boolean; locale?: string; reason?: string; error?: string };
  whisper: { installed: boolean; installing: boolean; progress: number; error?: string };
}
export interface VoicePermission { status: string; platform: string; }
