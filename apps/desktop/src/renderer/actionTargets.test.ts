import { describe, expect, it } from 'vitest';
import { cssRule, cssUtility, stylesheet } from './tests/css.js';

const sheet = stylesheet('styles.css');
describe('comfortable action targets', () => {
  it('uses real 44px minimum targets rather than overlapping invisible padding', () => {
    expect(cssUtility(sheet, 'action-target')).toMatchObject({
      'min-width': '44px', 'min-height': '44px', 'flex-shrink': '0',
    });
  });

  it('limits the compact height exception to native caption-strip chrome', () => {
    expect(cssRule(sheet, '#command-titlebar-slot .btn')['min-height']).toBe('28px');
    expect(cssRule(sheet, '.voice-island')['flex']).toBe('0 0 44px');
  });
});
