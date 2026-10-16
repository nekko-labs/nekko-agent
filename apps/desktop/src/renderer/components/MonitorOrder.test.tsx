import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE, sanitizeMonitorsDock } from '../commandWall.js';
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => ({ byToken: {}, answered: new Set() }) }));
vi.mock('./InsightsBox.js', () => ({ InsightsBox: () => null }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
vi.mock('./ResourceMonitor.js', () => ({ useMonitors: () => ({}), useResourceSample: () => ({ system: null, gpu: null }) }));
import { MonitorsDock } from './MonitorsDock.js';

function render(side: string) {
  const dock = sanitizeMonitorsDock({ side, monitorOrder: ['budget', 'hardware', 'insights'], panels: { automations: false, utilization: false, insights: true }, minimized: { budget: true } });
  return renderToStaticMarkup(<MonitorsDock state={{ ...DEFAULT_WALL_STATE, dock }} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
}

describe('dock reorder headers', () => {
  it.each(['left', 'right'])('renders saved order and accessible draggable headers on the %s', side => {
    const html = render(side);
    expect(html.indexOf('aria-label="Hardware monitor"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Hardware monitor"')).toBeLessThan(html.indexOf('aria-label="Insights monitor"'));
    expect(html).not.toContain('aria-label="Vitals monitor"');
    expect(html).toContain('draggable="true" tabindex="0"');
    expect(html).toContain('Hardware monitor header; use Alt+ArrowUp or Alt+ArrowDown to reorder');
    expect(html).toContain('aria-label="Expand Budget monitor"');
    expect(html).not.toContain('aria-label="Budget monitor"');
    expect(html).toContain('aria-label="Minimize Hardware monitor"');
  });
  it('opens a dashed landing zone while dragging and flies the panel into it on drop', () => {
    const html = render('right');
    // No zones until a panel is lifted.
    expect(html).not.toContain('monitors-dock__landing');
    expect(html).toContain('data-monitor="hardware"');
    const source = readFileSync(new URL('./MonitorsDock.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<LandingZone open={slot === restIndex} height={lift.height} />');
    expect(source).toContain('placeMonitor(s.dock.monitorOrder, key, anchor.key, where)');
    expect(source).toContain('node.animate([');
    const css = readFileSync(new URL('./monitorsDock.css', import.meta.url), 'utf8');
    expect(css).toContain('.monitors-dock__landing[data-open] { height: calc(var(--landing-height) + 12px); }');
    expect(css).toMatch(/\.monitors-dock__landing > span \{[^}]*dashed/);
    expect(css).toContain('.monitors-dock__monitor[data-monitor-lifted] { display: none; }');
  });
  it.each(['top', 'bottom'])('does not expose vertical reorder controls on the %s', side => {
    const html = render(side);
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain('Alt+ArrowUp');
  });
});
