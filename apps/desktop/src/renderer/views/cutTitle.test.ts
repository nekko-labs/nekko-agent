import { describe, expect, it } from 'vitest';
import { cutTitle } from './cutTitle';

const message = 'these side icons are miss aligned from how they look in the other panel';

describe('cutTitle', () => {
  it('marks an older placeholder cut with no "…" and hovers the whole message', () => {
    expect(cutTitle('these side icons are miss aligned from how they ', message)).toEqual({
      shown: 'these side icons are miss aligned from how they…',
      full: message,
    });
  });

  it('keeps a new placeholder that already ends in "…"', () => {
    expect(cutTitle('these side icons are miss aligned from how they…', message)?.shown).toBe('these side icons are miss aligned from how they…');
  });

  it('matches across folded whitespace in the message', () => {
    expect(cutTitle('these side icons are miss aligned from how they', 'these side icons\nare miss   aligned from how they look')?.full)
      .toBe('these side icons are miss aligned from how they look');
  });

  it('leaves chosen, short, whole and unrelated titles alone', () => {
    expect(cutTitle('Sidebar icon alignment', message)).toBeNull();
    expect(cutTitle('these side', message)).toBeNull();
    expect(cutTitle(message, message)).toBeNull();
    expect(cutTitle('these side icons are miss aligned from how they', undefined)).toBeNull();
  });

  it('caps a long message on hover', () => {
    const long = `${message} ${'word '.repeat(300)}`;
    const full = cutTitle(message.slice(0, 48), long)!.full;
    expect(full.length).toBeLessThanOrEqual(601);
    expect(full.endsWith('…')).toBe(true);
  });
});
