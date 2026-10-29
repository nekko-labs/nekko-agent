/** Per-reply measurements: accumulated while a turn runs, kept on its last message. */

import type { ChatMessage, TurnStats } from './chat.js';
import type { EffortLevel } from './settings.js';

/** Output tokens per second over decode time, falling back to wall time. */
export function turnTokensPerSecond(stats: Pick<TurnStats, 'outputTokens' | 'outputMs' | 'wallMs'>): number {
  const ms = stats.outputMs && stats.outputMs > 0 ? stats.outputMs : stats.wallMs;
  return ms > 0 ? stats.outputTokens / (ms / 1000) : 0;
}
