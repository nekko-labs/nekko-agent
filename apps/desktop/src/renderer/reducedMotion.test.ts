import { describe, expect, it } from 'vitest';
import { cssRule, stylesheet } from './tests/css.js';

/** What every element gets with OS animations off (the global reduce-motion rule). */
const reduced = (selector: string) => cssRule(stylesheet('styles.css'), selector, { media: 'prefers-reduced-motion: reduce' });

describe('reduced-motion CSS', () => {
  // transition-property defaults to `all`, so a tiny non-zero duration on `*`
  // transitions every changed property, layout included. The windowed
  // transcript's spacer padding then trailed each row swap by a frame and the
  // chat bounced instead of reaching the bottom (only with OS animations off).
  it.each(['*', '*::before', '*::after'])('turns transitions off on %s with 0s rather than a tiny duration', (selector) => {
    expect(reduced(selector)['transition-duration']).toBe('0s !important');
  });

  it('still keeps animations a hair above zero so animationend fires', () => {
    expect(reduced('*')['animation-duration']).toBe('0.01ms !important');
  });
});
