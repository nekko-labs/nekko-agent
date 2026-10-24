import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, hasSelector, stylesheet } from '../tests/css.js';
import { loadWall, summary, windowBody } from '../tests/renderWall.js';
import { AgentPanelControls } from './AgentPanelControls.js';
import { NumberedAgentIcon } from './NumberedChatIcon.js';

const noop = () => {};
const styles = stylesheet('styles.css');
const layouts = stylesheet('components/commandWallLayouts.css');
const two = { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never, layout: { mode: 'grid' as const, cols: 2, rows: 1 } };

describe('agent panel controls', () => {
  it('are icon-only buttons that explain themselves in a hover tooltip instead of growing a label', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show orientation="vertical" onToggle={noop} onOrientation={noop} />);
    expect(html).toContain('aria-label="Hide the agent panel"');
    expect(html).toContain('aria-label="Show agents in a row"');
    expect(html).not.toContain('agent-panel-pill-label');
    expect(html).toContain('data-hover-tip="Hide agents"');
    expect(html).toContain('data-hover-tip="Show agents in a row"');
    // No native title alongside the tooltip, and a fixed size that never grows.
    expect(html).not.toContain('title=');
    expect(cssRule(layouts, '.agent-panel-pill')).toMatchObject({ width: '28px', height: '28px' });
    expect(hasSelector(layouts, /agent-panel-pill-label/)).toBe(false);
  });
  it('stack in a row panel and lie in a row in a column panel, and swap again when collapsed', () => {
    const stacked = (show: boolean, orientation: 'vertical' | 'horizontal') =>
      renderToStaticMarkup(<AgentPanelControls show={show} orientation={orientation} onToggle={noop} onOrientation={noop} />).includes('data-stacked');
    expect(stacked(true, 'horizontal')).toBe(true);
    expect(stacked(true, 'vertical')).toBe(false);
    expect(stacked(false, 'vertical')).toBe(true);
    expect(stacked(false, 'horizontal')).toBe(false);
  });
  it('offers the panel back while collapsed', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show={false} orientation="vertical" onToggle={noop} onOrientation={noop} />);
    expect(html).toContain('aria-label="Show the agent panel"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-collapsed="true"');
  });
});

describe('agent window identity and activity', () => {
  it('draws an agent with the window number as its face, in every wall window strip', async () => {
    const html = renderToStaticMarkup(<NumberedAgentIcon number={4} />);
    expect(html).toContain('numbered-agent-icon');
    expect(html).toContain('aria-label="Window 4"');
    expect(html).toContain('Ctrl+4 selects it');
    const wall = (await loadWall()).render(two, { sessions: [summary('a'), summary('b')] });
    expect(windowBody(wall, 'a')).toMatch(/data-frame-icon[^]*numbered-agent-icon[^]*aria-label="Window 1"/);
    expect(windowBody(wall, 'b')).toMatch(/data-frame-icon[^]*numbered-agent-icon[^]*aria-label="Window 2"/);
    expect(wall).not.toContain('numbered-chat-icon');
  });
  it('gives a working window a quieter copy of the composer beam', async () => {
    const wall = (await loadWall()).render(two, { sessions: [summary('a'), summary('b')], running: ['a'] });
    expect(windowBody(wall, 'a')).toContain('class="composer-beam-ring wall-window-beam"');
    expect(windowBody(wall, 'b')).not.toContain('wall-window-beam');
    expect(cssRule(styles, '.wall-window-beam').opacity).toBe('0.55');
    expect(cssRule(styles, '.wall-window-beam .composer-beam-spin')['animation-duration']).toBe('5s');
  });
});

describe('wall chrome fixes', () => {
  it('floats the composer resize grips outside its edges', () => {
    expect(cssRule(styles, '.wall-composer.panel').overflow).toBe('visible');
    expect(cssRule(styles, '.wall-composer-side[data-edge="left"]').left).toBe('-14px');
    expect(cssRule(styles, '.wall-composer-side[data-edge="right"]').right).toBe('-14px');
    expect(cssRule(styles, '.wall-composer[data-dock^="bottom"] > .wall-composer-split').top).toBe('-14px');
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
