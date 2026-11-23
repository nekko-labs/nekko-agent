import { describe, expect, it } from 'vitest';
import { cssRule, cssUtility, stylesheet } from './tests/css.js';

const sheet = stylesheet('styles.css');
describe('comfortable action targets', () => {
  it('uses real 44px minimum targets rather than overlapping invisible padding', () => {
    expect(cssUtility(sheet, 'action-target')).toMatchObject({
      'min-width': '44px', 'min-height': '44px', 'flex-shrink': '0',
    });
  });

  it('keeps buttons slim for a pointer and 44px for a finger', () => {
    const btn = cssUtility(sheet, 'btn');
    expect(btn['min-height']).toBe('28px');
    const touch: Record<string, string> = {};
    sheet.walkAtRules('utility', (at) => {
      if (at.params.trim() !== 'btn') return;
      at.walkAtRules('apply', (apply) => { expect(apply.params).not.toContain('action-target'); });
      at.walkAtRules('media', (media) => {
        if (!media.params.includes('pointer: coarse')) return;
        media.walkDecls((d) => { touch[d.prop] = d.value; });
      });
    });
    expect(touch).toMatchObject({ 'min-width': '44px', 'min-height': '44px' });
  });

  it('limits the compact height exception to native caption-strip chrome', () => {
    expect(cssRule(sheet, '#command-titlebar-slot .btn')['min-height']).toBe('28px');
  });

  it("sizes the composer bar's attach, microphone and send like the model chip, 44px for a finger", () => {
    expect(cssRule(sheet, '.composer-bar .composer-bar-button')).toMatchObject({ width: '28px', height: '28px', 'min-width': '28px', 'min-height': '28px' });
    expect(cssRule(sheet, '.voice-island')['flex']).toBe('0 0 28px');
    const touch: Record<string, string> = {};
    sheet.walkAtRules('media', (media) => {
      if (!media.params.includes('pointer: coarse')) return;
      media.walkRules('.composer-bar .composer-bar-button', (r) => r.walkDecls((d) => { touch[d.prop] = d.value; }));
      media.walkRules('.voice-island:not(.is-open)', (r) => r.walkDecls((d) => { touch[`island-${d.prop}`] = d.value; }));
    });
    expect(touch).toMatchObject({ width: '44px', height: '44px', 'min-width': '44px', 'min-height': '44px', 'island-flex-basis': '44px' });
  });
});
