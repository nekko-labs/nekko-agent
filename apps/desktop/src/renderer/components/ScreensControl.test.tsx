import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => null, { getState: () => ({ pushToast: () => {} }) }) }));
import { OpenNewAgentsOptions, OpenNewAgentsSettings, ScreensControl, ScreensMenu } from './ScreensControl.js';
import type { DisplaysState } from '../displays.js';

const screen = (id: string, x: number, extra: Partial<DisplaysState['displays'][number]> = {}) => ({
  id, label: id, bounds: { x, y: 0, width: 1920, height: 1080 }, main: false, primary: false, enabled: false, self: false, scaleFactor: 1, ...extra,
});
const state: DisplaysState = { placement: 'empty-first', displays: [screen('1', 0, { main: true, primary: true, enabled: true, self: true }), screen('2', 1920)] };

describe('Screens dropdown', () => {
  it('is absent outside the desktop shell', () => {
    expect(renderToStaticMarkup(<ScreensControl />)).toBe('');
  });

  it('lists screens in a row, the main one locked on', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} open onToggle={() => {}} />);
    expect(html).toContain('aria-label="Screens: 1 of 2 on"');
    expect(html).toContain('aria-label="Screen 1, main window, always on"');
    expect(html).toMatch(/aria-checked="true" aria-label="Screen 1, main window, always on" aria-disabled="true"/);
    expect(html).toContain('aria-label="Screen 2, off"');
    expect(html.indexOf('Screen 1')).toBeLessThan(html.indexOf('Screen 2'));
  });

  it('leaves where new agents open to Settings', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} embedded open onToggle={() => {}} />);
    expect(html).not.toContain('Open new agents');
    expect(html).not.toContain('Balanced');
    expect(renderToStaticMarkup(<OpenNewAgentsSettings />)).toBe('');
    const options = renderToStaticMarkup(<OpenNewAgentsOptions state={state} onPlacement={() => {}} onSpacesMode={() => {}} />);
    expect(options).toContain('Prioritize main screen first');
    expect(options).toMatch(/checked=""[^>]*\/><span><strong>Balanced/);
  });

  it('reveals details for an already active secondary screen', () => {
    const active = { ...state, displays: state.displays.map(d => ({ ...d, enabled: true })) };
    const html = renderToStaticMarkup(<ScreensMenu state={active} embedded open onToggle={() => {}} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('inert=""');
  });
  it('closed, it is just the button', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} open={false} onToggle={() => {}} />);
    expect(html).toContain('data-screens-button');
    expect(html).not.toContain('role="dialog"');
  });

  it('embeds screens in View without a nested button or dialog', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} embedded open onToggle={() => {}} />);
    expect(html).not.toContain('data-screens-button');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('aria-label="Screens to use"');
  });
  it('explains a single connected screen without a redundant locked toggle', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={{ ...state, displays: [state.displays[0]] }} embedded open onToggle={() => {}} />);
    expect(html).toContain('Use more than one screen');
    expect(html).toContain('data-expanded="false" inert="" aria-hidden="true"');
    expect(html).not.toContain('screens-single');
    expect(html).not.toContain('role="switch"');
  });
  it('explains how to toggle additional screens', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} embedded open onToggle={() => {}} />);
    expect(html).toContain('Select a screen to open or close its Nekko window.');
    expect(html).not.toContain('screens-single');
  });
  it('keeps the dropdown out of the title bar drag region, so hover and clicks reach it', () => {
    // The toolbar is portaled into the draggable title bar; without no-drag the OS
    // took the pointer over the panel, so it closed on hover and ate clicks.
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.screens-picker \{ -webkit-app-region: no-drag;/);
    expect(css).toMatch(/\.screens-control::after \{[^}]*-webkit-app-region: no-drag;/);
    const src = readFileSync(new URL('./ScreensControl.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('setOpen((v) => !v)');
  });
  it('lists desktops on one screen and explains Accessibility before the first switch', () => {
    const desk = (n: number, extra = {}) => ({ id: `space-${n}`, label: String(n), current: n === 1, main: n === 1, enabled: n === 1, waiting: false, self: n === 1, ...extra });
    const one: DisplaysState = { ...state, displays: [state.displays[0]], spaces: { mode: 'ask', access: false, desktops: [desk(1), desk(2), desk(3, { enabled: true, waiting: true })] } };
    const html = renderToStaticMarkup(<ScreensMenu state={one} open onToggle={() => {}} asking="space-2" />);
    expect(html).toContain('aria-label="Desktops: 2 of 3 on"');
    expect(html).toContain('aria-label="Desktops to use"');
    expect(html).toContain('aria-label="Desktop 3, opens when you get there"');
    expect(html).toContain('Accessibility');
    for (const label of ['Allow and switch', 'Open when I get there', 'switch to desktop 2']) expect(html).toContain(label);
    expect(html).toContain('class="spaces-demo"');
    expect(html).not.toContain('Connect another screen');
    // Chosen once, the mode is a Settings option, and a missing permission is explained in the menu.
    const switched = { ...one, spaces: { ...one.spaces!, mode: 'switch' as const } };
    expect(renderToStaticMarkup(<ScreensMenu state={switched} open onToggle={() => {}} />)).toContain('Accessibility is off for Nekko');
    const chosen = renderToStaticMarkup(<OpenNewAgentsOptions state={switched} onPlacement={() => {}} onSpacesMode={() => {}} />);
    expect(chosen).toContain('aria-label="How a desktop is reached"');
    // Two separate choices: each is a labelled group, the desktop one after the screen one (#2399).
    expect(chosen.indexOf('Across screens')).toBeLessThan(chosen.indexOf('Balanced'));
    expect(chosen.indexOf('Balanced')).toBeLessThan(chosen.indexOf('On another desktop'));
    expect(chosen.indexOf('On another desktop')).toBeLessThan(chosen.indexOf('Switch me there'));
    expect(chosen).toContain('class="screens-group"');
    // Not yet chosen (or no desktops), there is one group and no labels.
    expect(renderToStaticMarkup(<OpenNewAgentsOptions state={one} onPlacement={() => {}} onSpacesMode={() => {}} />)).not.toContain('Across screens');
    expect(renderToStaticMarkup(<OpenNewAgentsOptions state={state} onPlacement={() => {}} onSpacesMode={() => {}} />)).not.toContain('On another desktop');
    expect(renderToStaticMarkup(<ScreensMenu state={state} open onToggle={() => {}} />)).not.toContain('Desktops');
  });
});
