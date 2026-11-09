/** Confirmed GitHub state for the fixed Nekko Agent repository. Never carries credentials. */
export interface SupportStarStatus {
  state: 'starred' | 'not-starred' | 'unavailable';
  login?: string;
  reason?: string;
  newlyStarred?: boolean;
}

export const SUPPORT_REPOSITORY_URL = 'https://github.com/nekko-labs/nekko-agent';

/**
 * The in-chat "star us on GitHub" ask (spec/platform/github-star-ask.md):
 * shown at most twice, after the 10th and the 50th prompt that got a finished
 * reply. The iPhone and Android apps use the same numbers.
 */
export const STAR_ASK_AT: readonly number[] = [10, 50];

/** What a device remembers about the ask. Kept locally, never synced or sent. */
export interface StarAskState {
  /** Prompts sent here that got a finished reply. */
  prompts: number;
  /** How many times the card has been shown. */
  asked: number;
  /** Starred, "Don't ask again", or a star GitHub already confirmed: never ask again. */
  stopped?: boolean;
}

export const STAR_ASK_START: StarAskState = { prompts: 0, asked: 0 };

/** Read a stored state, treating anything malformed as a fresh start. */
export function parseStarAsk(raw: string | null | undefined): StarAskState {
  try {
    const v = JSON.parse(raw ?? '') as Partial<StarAskState>;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    return { prompts: n(v.prompts), asked: n(v.asked), ...(v.stopped === true ? { stopped: true } : {}) };
  } catch {
    return { ...STAR_ASK_START };
  }
}

/** One more prompt got its reply. */
export function countStarAskPrompt(state: StarAskState): StarAskState {
  return { ...state, prompts: state.prompts + 1 };
}

/** Whether the reply that just finished should carry the card. */
export function starAskDue(state: StarAskState): boolean {
  if (state.stopped) return false;
  const at = STAR_ASK_AT[state.asked];
  return at !== undefined && state.prompts >= at;
}

/**
 * The card was shown: this ask is used up whatever happens next (ignoring it is
 * "Not now"), and so is any later one whose count is already reached, so two
 * asks never come back to back.
 */
export function markStarAskShown(state: StarAskState): StarAskState {
  const reached = STAR_ASK_AT.filter((at) => state.prompts >= at).length;
  return { ...state, asked: Math.max(state.asked + 1, reached) };
}

/** Starred, "Don't ask again", or already starred: never again. */
export function stopStarAsk(state: StarAskState): StarAskState {
  return { ...state, stopped: true };
}
