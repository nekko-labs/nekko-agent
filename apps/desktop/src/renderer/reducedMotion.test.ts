import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The global reduce-motion block (the one with the universal selector). */
function globalReduceBlock(): string {
  const at = css.search(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{/);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', css.indexOf('{', css.indexOf('{', at) + 1)) + 1);
}

describe('reduced-motion CSS', () => {
  // transition-property defaults to `all`, so a tiny non-zero duration on `*`
  // transitions every changed property, layout included. The windowed
  // transcript's spacer padding then trailed each row swap by a frame and the
  // chat bounced instead of reaching the bottom (only with OS animations off).
  it('turns transitions off with 0s rather than a tiny duration', () => {
    const block = globalReduceBlock();
    expect(block).toMatch(/transition-duration:\s*0s\s*!important/);
    expect(block).not.toMatch(/transition-duration:\s*0\.0\d*m?s/);
  });

  it('still keeps animations a hair above zero so animationend fires', () => {
    expect(globalReduceBlock()).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});
