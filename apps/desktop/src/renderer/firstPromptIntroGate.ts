import type { AppSettings, SessionSummary } from '@nekko-agent/shared';

/**
 * Whether the new-chat screen should open the "Send your first prompt" intro:
 * only on someone's first ever chat. Kept apart from the intro itself, which
 * pulls in Remotion and is loaded only when it shows.
 *
 * The chat list must have loaded (it is empty until then, and the new chat
 * itself is in it once it has), and no chat may have an exchange yet: people
 * who already chatted before the intro existed never see it.
 *
 * It also waits for first-run setup to close, so a new user never gets the
 * intro stacked on the wizard. (The zones tour opens only when someone picks
 * Multi-agent, so there is nothing else to wait for.)
 */
export function shouldShowFirstPromptIntro({ cleanStart, settings, sessions, setupOpen = false }: {
  cleanStart: boolean;
  settings: Pick<AppSettings, 'firstPromptIntroSeen' | 'showTips'> | null | undefined;
  sessions: Pick<SessionSummary, 'exchangeCount'>[];
  setupOpen?: boolean;
}): boolean {
  if (!cleanStart || !settings || settings.firstPromptIntroSeen || setupOpen) return false;
  if (settings.showTips === false) return false;
  return sessions.length > 0 && sessions.every((s) => !s.exchangeCount);
}
