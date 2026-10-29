import { describe, expect, it } from 'vitest';
import { cssRule, cssValue, stylesheet } from './tests/css.js';

const board = stylesheet('components/commandWallLayouts.css');
const dock = stylesheet('components/monitorsDock.css');

describe('side panel resize grips', () => {
  it('has no permanent agent-list boundary', () => {
    expect(cssRule(board, ".wall-agents-presence[data-orientation='vertical'][data-panel-open='true']")['box-shadow']).toBeUndefined();
  });

  it('keeps outboard grips hit-testable while clipping closed panels to zero', () => {
    for (const [css, selector] of [[board, '.wall-agents-presence'], [dock, '.monitors-dock']] as const) {
      expect(cssRule(css, selector)).toMatchObject({ overflow: 'visible', 'clip-path': 'inset(0 -10px)' });
      expect(cssRule(css, `${selector}[data-panel-open='false']`)).toMatchObject({ 'clip-path': 'inset(0)', 'pointer-events': 'none' });
    }
    expect(cssRule(board, '.wall-agents-presence', { media: 'max-width: 767px' })['clip-path']).toBe('none');
  });

  it('raises hit targets above adjacent content without changing their layout widths', () => {
    expect(cssRule(board, '.agent-list-resize')['z-index']).toBe('5');
    expect(cssRule(dock, '.monitors-dock')['z-index']).toBe('5');
    expect(cssRule(dock, '.monitors-dock__resize')).toMatchObject({ width: '10px', 'z-index': '5' });
  });

  it('uses opaque bright grips, revealed on hover, keyboard focus and active drag', () => {
    for (const [css, handle] of [[board, '.agent-list-resize'], [dock, '.monitors-dock__resize']] as const) {
      expect(cssRule(css, `${handle} > .pane-grip`).background).toBe(cssValue('color-mix(in srgb, var(--accent) 70%, white)'));
    }
    expect(cssRule(board, '.agent-list-resize:is(:hover, :focus-visible, :active) > .pane-grip').opacity).toBe('1');
    for (const state of [':hover', ':focus-visible', ':active']) {
      expect(cssRule(dock, `.monitors-dock__resize${state} > .monitors-dock__grip`).opacity).toBe('1');
    }
    expect(cssRule(dock, '.monitors-dock__grip').opacity).toBe('0');
  });
});
