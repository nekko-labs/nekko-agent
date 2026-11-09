/** Confirmed GitHub state for the fixed Nekko Agent repository. Never carries credentials. */
export interface SupportStarStatus {
  state: 'starred' | 'not-starred' | 'unavailable';
  login?: string;
  reason?: string;
  newlyStarred?: boolean;
}

export const SUPPORT_REPOSITORY_URL = 'https://github.com/nekko-labs/nekko-agent';
