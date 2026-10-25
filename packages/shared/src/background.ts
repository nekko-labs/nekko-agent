/**
 * Automations running in the background on a local model, and whether they
 * are paused for the person at the computer (`background:state`, and the
 * `background:updated` event; nekkod's `background.rs`).
 */

/** Why paused turns wait: someone is here, a chat of theirs uses a local model, or the machine is strained. */
export type BackgroundReason = 'active' | 'chat' | 'battery' | 'lowBattery' | 'hot';

export interface BackgroundState {
  /** Background turns on a local model, running or paused. */
  running: number;
  paused: number;
  /** The commonest reason among the paused ones. */
  reason: BackgroundReason | null;
}

export const NO_BACKGROUND: BackgroundState = { running: 0, paused: 0, reason: null };

const REASONS: Record<BackgroundReason, string> = {
  active: 'you’re using the computer',
  chat: 'your chat is using the model',
  battery: 'on battery',
  lowBattery: 'battery low',
  hot: 'running hot',
};

/** "Background: 1 paused · you're using the computer", or null when nothing runs in the background. */
export function backgroundLine(s: BackgroundState | null | undefined): string | null {
  if (!s || s.running <= 0) return null;
  if (s.paused > 0) {
    const why = s.reason ? ` · ${REASONS[s.reason] ?? s.reason}` : '';
    return `Background: ${s.paused} paused${why}`;
  }
  return `Background: ${s.running} running`;
}
