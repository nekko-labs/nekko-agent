import type { WorkProfile } from '@nekko-agent/shared';

/** How much a reply shows. Minimal and Regular are Simple mode; Detailed is Detailed mode. */
export type DetailLevel = 'minimal' | 'regular' | 'detailed';

export interface ProfileCard {
  id: WorkProfile;
  title: string;
  desc: string;
  level: DetailLevel;
}

/** Setup's "What do you mostly do?" cards. A card only seeds the detail level (and with it, monitors). */
export const PROFILES: readonly ProfileCard[] = [
  { id: 'developer', title: 'Developer', desc: 'Code, terminals, pull requests', level: 'detailed' },
  { id: 'designer', title: 'Designer', desc: 'Interfaces, prototypes, assets', level: 'regular' },
  { id: 'writer', title: 'Writer or researcher', desc: 'Drafts, sources, summaries', level: 'regular' },
  { id: 'business', title: 'Product or business', desc: 'Plans, docs, spreadsheets', level: 'regular' },
  { id: 'student', title: 'Student', desc: 'Learning, notes, projects', level: 'regular' },
  { id: 'exploring', title: 'Just exploring', desc: 'Show me what you can do', level: 'minimal' },
];

export const LEVELS: ReadonlyArray<{ id: DetailLevel; title: string; desc: string }> = [
  { id: 'minimal', title: 'Minimal', desc: 'The answer, with fewer extras and no reply stats.' },
  { id: 'regular', title: 'Regular', desc: 'The answer, plus a tidy summary of what I did.' },
  { id: 'detailed', title: 'Detailed', desc: 'Tool steps, available reasoning and reply stats.' },
];

export const levelForProfile = (profile?: WorkProfile | null): DetailLevel =>
  PROFILES.find((p) => p.id === profile)?.level ?? 'regular';

/** Detailed opens the Monitors panel by default; the other levels keep it closed. */
export const monitorsDefault = (level: DetailLevel) => level === 'detailed';

/**
 * Simple mode choices Minimal adds on top of Simple: the Changes chip, prompt
 * tips and the usage ring leave the screen. Regular and Detailed clear them,
 * so moving between levels never leaves one stuck.
 */
export const MINIMAL_HIDES = ['changes', 'suggest', 'context'] as const;

/** What the setup wizard's email field accepts, matching Nekko Cloud's own check. */
export const validEmail = (email: string) => {
  const e = email.trim();
  return e.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
};

/** The level the saved mode and Simple choices amount to, for a step opened a second time. */
export function currentLevel(expert: boolean, choices: Record<string, string>): DetailLevel {
  if (expert) return 'detailed';
  return MINIMAL_HIDES.every((id) => choices[id] === 'hide') ? 'minimal' : 'regular';
}
