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
 * It also waits for the zones intro, which opens on the first visit to the
 * Agents board, so a new user never gets two intros stacked: it comes after
 * that one is closed (unless the board is not in zones).
 */
export function shouldShowFirstPromptIntro({ cleanStart, settings, sessions }: {
  cleanStart: boolean;
  settings: (Pick<AppSettings, 'firstPromptIntroSeen' | 'showTips'> & { commandWall?: Pick<NonNullable<AppSettings['commandWall']>, 'zones' | 'zonesIntro'> }) | null | undefined;
  sessions: Pick<SessionSummary, 'exchangeCount'>[];
}): boolean {
  if (!cleanStart || !settings || settings.firstPromptIntroSeen) return false;
  if (settings.showTips === false) return false;
  if (settings.commandWall?.zones !== false && !settings.commandWall?.zonesIntro) return false;
  return sessions.length > 0 && sessions.every((s) => !s.exchangeCount);
}
