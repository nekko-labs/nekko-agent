import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ chrome: true, mac: false, view: 'command' }));
vi.mock('../chrome.js', () => ({ get hasAppChrome() { return state.chrome; }, get isMacChrome() { return state.mac; } }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: { view: string }) => unknown) => select({ view: state.view }), { getState: () => ({}) }) }));
vi.mock('../components/UpdateBanner.js', () => ({ UpdateControl: () => <span data-version>0.8.0</span> }));
vi.mock('../components/DeveloperServerControls.js', () => ({ DeveloperServerControls: () => null }));
vi.mock('../components/AgentWindowPicker.js', () => ({ AgentWindowPicker: () => null }));
vi.mock('../components/InsightsBox.js', () => ({}));
vi.mock('../components/CommandWall.js', () => ({ CommandWall: () => null, TerminalExcerpt: () => null }));
vi.mock('../components/WallComposer.js', () => ({ WallComposer: () => null }));
vi.mock('../components/MonitorsDock.js', () => ({ MonitorsDock: () => null }));
import { TitleBar } from '../components/TitleBar.js';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
import { LAYOUT_LABEL, WallToolbar } from './CommandCenterView.js';

const toolbar = () => renderToStaticMarkup(<WallToolbar wall={DEFAULT_WALL_STATE} setWall={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);

describe('Agents header placement', () => {
  beforeEach(() => { state.chrome = true; state.mac = false; state.view = 'command'; });
  it.each([false, true])('puts a single heading beside the brand in desktop chrome (mac=%s)', (mac) => {
    state.mac = mac;
    const title = renderToStaticMarkup(<TitleBar />);
    // The brand mark stands alone (no wordmark), still named for assistive tech.
    expect(title).not.toContain('Nekko Agent</span>');
    expect(title).toContain('aria-label="Nekko Agent"');
    expect(title).not.toContain('data-part="pixel-head"');
    expect(title).toContain('viewBox="0 -2.989 24 24"');
    expect(title).toContain('width="28"');
    expect(title).toContain('class="titlebar-heading');
    expect(title.indexOf('>Agents</h1>')).toBeLessThan(title.indexOf('data-version'));
    expect(title.indexOf('data-version')).toBeLessThan(title.indexOf('id="command-titlebar-slot"'));
    expect(title.match(/<h1/g)).toHaveLength(1);
    expect(toolbar()).not.toContain('<h1');
    expect(title).not.toContain('pr-[150px]');
  });
  it.each([['settings', 'Settings'], ['models', 'Models'], ['modelserver', 'Models'], ['skills', 'Skills']])('names the %s view in the title bar, not Agents', (view, label) => {
    state.view = view;
    const title = renderToStaticMarkup(<TitleBar />);
    expect(title).toContain('>' + label + '</h1>');
    expect(title).not.toContain('>Agents</h1>');
    expect(title.match(/<h1/g)).toHaveLength(1);
  });
  it('keeps the in-view heading when there is no desktop title bar', () => {
    state.chrome = false;
    expect(renderToStaticMarkup(<TitleBar />)).toBe('');
    expect(toolbar()).toMatch(/<h1[^>]*>Agents<\/h1>/);
  });
  it.each([true, false])('removes wall counts while retaining all controls (chrome=%s)', (chrome) => {
    state.chrome = chrome;
    const html = toolbar();
    expect(html).not.toContain('on the wall');
    expect(html).not.toContain('0 agents');
    expect(html).not.toContain('0 terminals');
    for (const label of ['Wall layout', 'Focused', 'Dynamic', 'Snap to grid']) expect(html).toContain(label);
    // The All/Agents/Terminals filter and the Monitors button left the toolbar;
    // the monitors panel shows and hides from its own corner.
    expect(html).not.toContain('aria-label="Show"');
    expect(html).not.toContain('>Terminals<');
    expect(html).not.toContain('>Monitors<');
    expect(html).not.toContain('Auto-arrange');
    expect(html).not.toContain('>Fixed<');
    // Adding lives in the toolbar's icon bar in every layout: agent, terminal,
    // without an overflow button. An agent's Changes/Files/Browser moved into
    // its own window header beside Logs.
    for (const label of ['New agent', 'New image session', 'New terminal']) expect(html).toContain(`aria-label="${label}"`);
    for (const label of ['Add window', 'Changes', 'Browser', 'Files']) expect(html).not.toContain(`aria-label="${label}"`);
    // The add bar leads the controls, left of the layout switcher.
    expect(html.indexOf('aria-label="Add to the wall"')).toBeLessThan(html.indexOf('aria-label="Wall layout"'));
  });
  it.each(['focus', 'grid', 'fixed'] as const)('only exposes snap to grid in free-form Dynamic (%s)', (mode) => {
    const layout = { ...DEFAULT_WALL_STATE.layout, mode: mode === 'fixed' ? 'grid' as const : mode, fixedGrid: mode === 'fixed' };
    const html = renderToStaticMarkup(<WallToolbar wall={{ ...DEFAULT_WALL_STATE, layout }} setWall={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);
    expect(html).toContain(`class="wall-auto-arrange" data-visible="${mode === 'grid'}"`);
    expect(html).toContain(`tabindex="${mode === 'grid' ? 0 : -1}"`);
    // A coloured magnet with sparks off its poles, not the old wand.
    expect(html).toContain('M6 12.5V10a6 6 0 0 1 12 0v2.5');
    expect(html).toContain('--magnet-spark');
    // Two layouts only: Grid is now Dynamic's Fixed grid setting.
    expect(html).not.toContain('>Grid<');
    expect(html).toContain('aria-label="Snap to grid"');
    // The agent panel's own controls moved into the panel; the title bar has none.
    expect(html).not.toContain('agent panel');
  });
  it('shows the magnet pressed while snap to grid is on, with its meaning in a tooltip', () => {
    const off = toolbar();
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('data-hover-tip="Snap to grid: keep windows evenly spaced"');
    const on = renderToStaticMarkup(<WallToolbar wall={{ ...DEFAULT_WALL_STATE, snap: true }} setWall={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);
    expect(on).toMatch(/aria-label="Snap to grid" aria-pressed="true"/);
    // The tip is a hover tooltip, not a native title that duplicates it.
    expect(on).not.toContain('title="Snap');
  });
  it('names the two layout modes Focused and Dynamic without migrating keys', () => {
    expect(LAYOUT_LABEL).toEqual({ focus: 'Focused', grid: 'Dynamic' });
    const html = toolbar();
    expect(html).toMatch(/title="Dynamic \((Ctrl|⌘)\+Shift\+2\)"/);
    expect(html).not.toContain('title="Grid');
    expect(html).not.toContain('Grid size');
    expect(html).toContain('M13 2 4 14h6l-1 8 9-12h-6z');
  });
  it('leaves the agent panel controls out of the title bar, open or closed', () => {
    const closed = { ...DEFAULT_WALL_STATE, agentPanel: { show: false, orientation: 'vertical' as const } };
    for (const wall of [closed, DEFAULT_WALL_STATE]) {
      const html = renderToStaticMarkup(<WallToolbar wall={wall} setWall={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);
      expect(html).not.toContain('Show the agent panel');
      expect(html).not.toContain('Hide the agent panel');
      expect(html).not.toContain('Show agents in a');
    }
  });
});
