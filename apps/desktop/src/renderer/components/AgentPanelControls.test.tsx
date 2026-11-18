import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, cssValue, hasSelector, stylesheet } from '../tests/css.js';
import { loadWall, summary, windowBody } from '../tests/renderWall.js';
import { AgentPanelControls } from './AgentPanelControls.js';

const noop = () => {};
const styles = stylesheet('styles.css');
const layouts = stylesheet('components/commandWallLayouts.css');
const two = { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never, layout: { mode: 'grid' as const, cols: 2, rows: 1 } };

describe('agent panel controls', () => {
  it('is an icon-only button that explains itself in a hover tooltip instead of growing a label', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show onToggle={noop} />);
    expect(html).toContain('aria-label="Hide the agent panel"');
    expect(html).not.toContain('agent-panel-pill-label');
    expect(html).toContain('data-hover-tip="Hide agents"');
    // No native title alongside the tooltip, and a fixed size that never grows.
    expect(html).not.toContain('title=');
    expect(cssRule(layouts, '.agent-panel-pill')).toMatchObject({ width: '28px', height: '28px' });
    expect(hasSelector(layouts, /agent-panel-pill-label/)).toBe(false);
  });
  it('offers no column or row switch: the panel is always a column', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show onToggle={noop} />);
    expect(html).not.toMatch(/Show agents in a (row|column)/);
    expect(hasSelector(layouts, /agent-panel-row|data-orientation/)).toBe(false);
  });
  it('lie in the header while open and stack down the wall edge when collapsed', () => {
    const stacked = (show: boolean) => renderToStaticMarkup(<AgentPanelControls show={show} onToggle={noop} />).includes('data-stacked');
    expect(stacked(true)).toBe(false);
    expect(stacked(false)).toBe(true);
  });
  it('offers the panel back while collapsed', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show={false} onToggle={noop} />);
    expect(html).toContain('aria-label="Show the agent panel"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-collapsed="true"');
  });
});

describe('agent window identity and activity', () => {
  it('numbers every wall window strip beside Nekko, the agent icon (no robot head)', async () => {
    const wall = (await loadWall()).render(two, { sessions: [summary('a'), summary('b')] });
    expect(windowBody(wall, 'a')).toMatch(/data-frame-icon[^]*class="wall-number"[^]*aria-label="Window 1"[^]*class="wall-mascot/);
    expect(windowBody(wall, 'b')).toMatch(/data-frame-icon[^]*class="wall-number"[^]*aria-label="Window 2"[^]*class="wall-mascot/);
    expect(windowBody(wall, 'a')).toContain('Ctrl+1 selects it');
    expect(wall).not.toContain('numbered-agent-icon');
    expect(wall).not.toContain('numbered-chat-icon');
  });
  it('keeps working status without an animated colored border', async () => {
    const wall = (await loadWall()).render(two, { sessions: [summary('a'), summary('b')], running: ['a'] });
    expect(windowBody(wall, 'a')).toContain('data-wall-working="true"');
    expect(wall).not.toContain('composer-beam');
    expect(hasSelector(styles, /composer-beam|wall-window-beam/)).toBe(false);
  });
});

describe('wall chrome fixes', () => {
  it('floats the composer resize grips outside its edges, the bottom one in the wall gap', () => {
    expect(cssRule(styles, '.wall-composer.panel').overflow).toBe('visible');
    expect(cssRule(styles, '.wall-composer-side[data-edge="left"]').left).toBe('-14px');
    expect(cssRule(styles, '.wall-composer-side[data-edge="right"]').right).toBe('-14px');
    expect(cssRule(styles, '.wall-composer[data-dock^="bottom"] > .wall-composer-split').top).toBe(cssValue('calc(-1 * var(--pane-gap))'));
  });
  it('reserves snap-to-grid space so revealing it never shifts the controls beside it', () => {
    const hidden = cssRule(styles, '.wall-auto-arrange');
    expect(hidden).toMatchObject({ 'grid-template-columns': '1fr', visibility: 'hidden' });
    expect(hidden.width).toBeUndefined();
    // Revealing it changes only paint (opacity, visibility, transform), never its box.
    const shown = cssRule(styles, ".wall-auto-arrange[data-visible='true']");
    for (const prop of ['margin', 'margin-left', 'grid-template-columns', 'width']) expect(shown[prop], prop).toBeUndefined();
    expect(shown.visibility).toBe('visible');
  });
});
