import type { AgentEvent } from '@nekko-agent/shared';
import { summarizeAsk } from '@nekko-agent/shared';

export interface NotificationContext {
  /** Whether notifications are enabled in Settings. */
  enabled: boolean;
  /** The window is hidden, minimized or behind another app. */
  windowHidden: boolean;
  /** The chat whose pane is on screen, if the chat view is showing. */
  visibleSessionId: string | null;
  /** The chat's title, for the body. */
  titleOf: (sessionId: string) => string | undefined;
}

export interface Notice {
  sessionId: string;
  kind: 'finished' | 'failed' | 'question' | 'approval';
  title: string;
  body: string;
}

/** Events that are not failures, just the user pressing Stop. */
const STOPS = new Set(['Stopped', 'Aborted', 'This operation was aborted']);

/** What, if anything, to tell the user about an event. Pure. */
export function decideNotification(event: AgentEvent, ctx: NotificationContext): Notice | null {
  if (!ctx.enabled) return null;
  if ((event as { relayOnly?: boolean }).relayOnly) return null;
  // A chat on screen in a focused window needs no toast; its pane shows it.
  if (!ctx.windowHidden && ctx.visibleSessionId === event.sessionId) return null;
  const chat = ctx.titleOf(event.sessionId)?.trim() || 'A chat';
  switch (event.type) {
    case 'done':
      return { sessionId: event.sessionId, kind: 'finished', title: 'Reply finished', body: chat };
    case 'error':
      if (STOPS.has(event.message.trim())) return null;
      return { sessionId: event.sessionId, kind: 'failed', title: 'Reply failed', body: `${chat}: ${event.message.slice(0, 120)}` };
    case 'question':
      return { sessionId: event.sessionId, kind: 'question', title: 'Nekko Agent has a question', body: `${chat}: ${summarizeAsk(event.request).slice(0, 120)}` };
    case 'tool_approval_required':
      return { sessionId: event.sessionId, kind: 'approval', title: 'Approval needed', body: `${chat}: ${event.reason || event.call.name}` };
    default:
      return null;
  }
}

