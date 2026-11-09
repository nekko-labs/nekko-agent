/**
 * The seasonal themes' dressing, in one place: which hat Nekko wears and which
 * hidden extras a date or hour turns on. Pure functions of the preset id and a
 * local date so the views stay declarative and the eggs are testable.
 *
 * Preset ids: Spooky persists as `autumn` (its original id), Winter as `winter`.
 */

/** A hat drawn on the head's 32-unit grid (Mascot.tsx `SeasonalHatArt`). */
export type SeasonalHat = 'wizard' | 'beanie' | 'santa';

export const isSpookyPreset = (preset: string | undefined) => preset === 'autumn';
export const isWinterPreset = (preset: string | undefined) => preset === 'winter';

/** December 24 and 25, local time. */
export function isChristmas(date: Date): boolean {
  return date.getMonth() === 11 && (date.getDate() === 24 || date.getDate() === 25);
}

/** Oshogatsu, the Japanese New Year: January 1 to 3, local time. */
export function isShogatsu(date: Date): boolean {
  return date.getMonth() === 0 && date.getDate() <= 3;
}

/** Late night, 22:00 to 03:59 local time, when the aurora comes out. */
export function isAuroraHour(date: Date): boolean {
  const h = date.getHours();
  return h >= 22 || h < 4;
}

/** The hat the chat mascot wears under a seasonal theme, or none. */
export function seasonalHat(preset: string | undefined, now: Date = new Date()): SeasonalHat | undefined {
  if (isSpookyPreset(preset)) return 'wizard';
  if (isWinterPreset(preset)) return isChristmas(now) ? 'santa' : 'beanie';
  return undefined;
}

/**
 * The six symbols scattered over a merged PR's banner under a seasonal theme,
 * or none. Winter's turn festive on Christmas and pine-and-bamboo kadomatsu
 * over Oshogatsu.
 */
export function mergeConfetti(preset: string | undefined, now: Date = new Date()): string[] | undefined {
  if (isSpookyPreset(preset)) return ['🍂', '🎃', '🍁', '🍂', '🎃', '🍁'];
  if (!isWinterPreset(preset)) return undefined;
  if (isChristmas(now)) return ['🎄', '❄️', '🎁', '🎄', '❄️', '🎁'];
  if (isShogatsu(now)) return ['🎍', '❄️', '🎍', '❄️', '🎍', '❄️'];
  return ['❄️', '⛄', '❄️', '⛄', '❄️', '⛄'];
}

/** Taps within this window count toward the greeting cat's snowball. */
export const SNOWBALL_TAP_WINDOW_MS = 1_500;
/** Taps in a row that make Nekko throw one. */
export const SNOWBALL_TAPS = 3;

/**
 * The tap times to keep after a new tap at `now`, and whether this tap throws
 * a snowball (which starts the count over).
 */
export function snowballTap(taps: readonly number[], now: number): { taps: number[]; throws: boolean } {
  const recent = [...taps.filter((t) => now - t <= SNOWBALL_TAP_WINDOW_MS), now];
  return recent.length >= SNOWBALL_TAPS ? { taps: [], throws: true } : { taps: recent, throws: false };
}
