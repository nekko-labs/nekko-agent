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
vi.mock('../components/WallDock.js', () => ({ WallDock: () => null }));
import { TitleBar } from '../components/TitleBar.js';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
import { LAYOUT_LABEL, WallToolbar } from './CommandCenterView.js';

const toolbar = () => renderToStaticMarkup(<WallToolbar wall={DEFAULT_WALL_STATE} setWall={() => {}} onAutoArrange={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);

describe('Agents header placement', () => {
  beforeEach(() => { state.chrome = true; state.mac = false; state.view = 'command'; });
  it.each([false, true])('puts a single heading beside the brand in desktop chrome (mac=%s)', (mac) => {
    state.mac = mac;
    const title = renderToStaticMarkup(<TitleBar />);
    // The brand mark stands alone (no wordmark), still named for assistive tech.
    expect(title).not.toContain('Nekko Agent</span>');
    expect(title).toContain('<title>Nekko Agent</title>');
    expect(title).toContain('width="28"');
    expect(title).toContain('class="titlebar-heading');
    expect(title.indexOf('>Agents</h1>')).toBeLessThan(title.indexOf('data-version'));
    expect(title.indexOf('data-version')).toBeLessThan(title.indexOf('id="command-titlebar-slot"'));
    expect(title.match(/<h1/g)).toHaveLength(1);
    expect(toolbar()).not.toContain('<h1');
    expect(title).not.toContain('pr-[150px]');
  });
  it('does not label other desktop views as Agents', () => {
    state.view = 'settings';
    expect(renderToStaticMarkup(<TitleBar />)).not.toContain('<h1');
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
    for (const label of ['Wall layout', 'Focus', 'Dynamic', 'Grid', 'Show', 'Auto-arrange', 'Panels']) expect(html).toContain(label);
    expect(html).not.toContain('>Fixed<');
    // Adding lives in the toolbar's icon bar in every layout: agent, terminal,
    // then More (the full picker). An agent's Changes/Files/Browser moved into
    // its own window header beside Logs.
    for (const label of ['New agent', 'New terminal', 'Add window']) expect(html).toContain(`aria-label="${label}"`);
    for (const label of ['Changes', 'Browser', 'Files']) expect(html).not.toContain(`aria-label="${label}"`);
    // The add bar leads the controls, left of the layout switcher.
    expect(html.indexOf('aria-label="Add to the wall"')).toBeLessThan(html.indexOf('aria-label="Wall layout"'));
  });
  it.each(['focus', 'grid', 'fixed'] as const)('only exposes magic in Dynamic (%s)', (mode) => {
    const html = renderToStaticMarkup(<WallToolbar wall={{ ...DEFAULT_WALL_STATE, layout: { ...DEFAULT_WALL_STATE.layout, mode } }} setWall={() => {}} onAutoArrange={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);
    expect(html).toContain(`class="wall-auto-arrange" data-visible="${mode === 'grid'}"`);
    expect(html).toContain(`tabindex="${mode === 'grid' ? 0 : -1}"`);
    // The agent panel's own controls moved into the panel; the title bar has none.
    expect(html).not.toContain('agent panel');
  });
  it('names the saved layout modes Focus, Dynamic and Grid without migrating keys', () => {
    expect(LAYOUT_LABEL).toEqual({ focus: 'Focus', grid: 'Dynamic', fixed: 'Grid' });
    const html = toolbar();
    expect(html).toMatch(/title="Dynamic \((Ctrl|⌘)\+Shift\+2\)"/);
    expect(html).toMatch(/title="Grid \((Ctrl|⌘)\+Shift\+3\)"/);
  });
  it('leaves the agent panel controls out of the title bar, open or closed', () => {
    const closed = { ...DEFAULT_WALL_STATE, agentPanel: { show: false, orientation: 'vertical' as const } };
    for (const wall of [closed, DEFAULT_WALL_STATE]) {
      const html = renderToStaticMarkup(<WallToolbar wall={wall} setWall={() => {}} onAutoArrange={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />);
      expect(html).not.toContain('Show the agent panel');
      expect(html).not.toContain('Hide the agent panel');
      expect(html).not.toContain('Show agents in a');
    }
  });
});
