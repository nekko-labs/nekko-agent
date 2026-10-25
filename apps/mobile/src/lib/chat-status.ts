import type { SessionSummary } from './protocol';
import type { Activity } from './transcript';

/** Live work/input wins; only the host knows which inactive chats have watches. */
export function remoteChatStatus(summary: Pick<SessionSummary, 'activeWatchCount'>, activity?: Activity): Activity | 'done' | 'idle' {
  return activity ?? ((summary.activeWatchCount ?? 0) > 0 ? 'idle' : 'done');
}
