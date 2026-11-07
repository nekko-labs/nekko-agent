import { describe, expect, it } from 'vitest';
import { cssRule, stylesheet } from '../tests/css.js';

// #1666: in a chat pane the plan floats over the transcript's foot, so the
// conversation scrolls on behind it and the cat instead of stopping at its top.
describe('the floating plan', () => {
  const css = stylesheet('styles.css');

  it('floats above the composer column instead of taking a row', () => {
    expect(cssRule(css, '[data-chat-surface="full"] .composer-column')).toMatchObject({ position: 'relative' });
    expect(cssRule(css, '[data-chat-surface="full"] .composer-column > .plan-sheet-dock')).toMatchObject({ position: 'absolute', bottom: '100%', left: '0', right: '0' });
  });

  it('stops at the composer top edge rather than painting over the box', () => {
    // The dock still tucks 10px under the composer (its -10px margin); the clip hides those 10px.
    expect(cssRule(css, '.plan-sheet-dock')).toMatchObject({ margin: '0 auto -10px' });
    expect(cssRule(css, '[data-chat-surface="full"] .composer-column > .plan-sheet-dock')['clip-path']).toBe('inset(-2px -14px 10px -14px)');
  });

  it('pads the transcript by the plan height, never less than the cat needs', () => {
    expect(cssRule(css, '[data-chat-surface="full"] [data-transcript-scroll]')['padding-bottom']).toBe('max(1.25rem,var(--chat-plan-clearance,0px))');
    expect(cssRule(css, '[data-session-id]:has(.composer > .chat-mascot) [data-transcript-scroll]')['padding-bottom']).toBe('max(68px,var(--chat-plan-clearance,0px))');
    expect(cssRule(css, '[data-chat-surface="full"] [data-scroll-latest]').bottom).toBe('max(0.75rem,var(--chat-plan-clearance,0px))');
  });
});
