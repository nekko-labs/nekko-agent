import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentPanelControls } from './AgentPanelControls.js';
import { NumberedAgentIcon } from './NumberedChatIcon.js';

const noop = () => {};
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const layouts = readFileSync(new URL('./commandWallLayouts.css', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');

describe('agent panel controls', () => {
  it('are icon pills whose label is there to grow out on hover', () => {
    const html = renderToStaticMarkup(<AgentPanelControls show orientation="vertical" onToggle={noop} onOrientation={noop} />);
    expect(html).toContain('aria-label="Hide the agent panel"');
    expect(html).toContain('aria-label="Show agents in a row"');
    expect(html.match(/agent-panel-pill-label/g)).toHaveLength(2);
    // Label first, icon last: it grows out to the left of the icon.
    expect(html.indexOf('Hide agents')).toBeLessThan(html.indexOf('<svg'));
    expect(layouts).toMatch(/\.agent-panel-pill:hover \.agent-panel-pill-label[^{]*\{ max-width: 120px; opacity: 1; \}/);
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
  it('draws an agent with the window number as its face', () => {
    const html = renderToStaticMarkup(<NumberedAgentIcon number={4} />);
    expect(html).toContain('numbered-agent-icon');
    expect(html).toContain('aria-label="Window 4"');
    expect(html).toContain('Ctrl+4 selects it');
    expect(wall).toContain('<NumberedAgentIcon number={n} />');
    expect(wall).not.toContain('<NumberedChatIcon');
  });
  it('gives a working window a quieter copy of the composer beam', () => {
    expect(wall).toContain("{agentStatus === 'working' && <span className=\"composer-beam-ring wall-window-beam\"");
    expect(styles).toMatch(/\.wall-window-beam \{[^}]*opacity: 0\.55;/);
    expect(styles).toMatch(/\.wall-window-beam \.composer-beam-spin \{[^}]*animation-duration: 5s;/);
  });
});

describe('wall chrome fixes', () => {
  it('floats the composer resize grips outside its edges', () => {
    expect(styles).toContain('.wall-composer.panel { overflow: visible; }');
    expect(styles).toContain('.wall-composer-side[data-edge="left"] { left: -14px; }');
    expect(styles).toContain('.wall-composer-side[data-edge="right"] { right: -14px; }');
    expect(styles).toContain('.wall-composer[data-dock^="bottom"] > .wall-composer-split { top: -14px; }');
  });
  it('reserves Auto-arrange space so revealing it never shifts the controls beside it', () => {
    expect(styles).not.toContain("[data-visible='true'] { width: 38px;");
    expect(styles).toMatch(/\.wall-auto-arrange \{[^}]*grid-template-columns: 1fr;[^}]*margin-left: 6px;[^}]*visibility: hidden;/);
    expect(styles).not.toMatch(/\.wall-auto-arrange[^{]*\{[^}]*grid-template-columns: 0fr/);
    expect(styles).not.toMatch(/\.wall-auto-arrange\[data-visible='true'\] \{[^}]*(margin|grid-template-columns|width)/);
  });
});
