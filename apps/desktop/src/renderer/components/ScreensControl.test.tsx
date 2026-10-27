import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => null, { getState: () => ({ pushToast: () => {} }) }) }));
import { ScreensControl, ScreensMenu } from './ScreensControl.js';
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
    const html = renderToStaticMarkup(<ScreensMenu state={state} open onToggle={() => {}} onPlacement={() => {}} />);
    expect(html).toContain('aria-label="Screens: 1 of 2 on"');
    expect(html).toContain('aria-label="Screen 1, main window, always on"');
    expect(html).toMatch(/aria-checked="true" aria-label="Screen 1, main window, always on" aria-disabled="true"/);
    expect(html).toContain('aria-label="Screen 2, off"');
    expect(html.indexOf('Screen 1')).toBeLessThan(html.indexOf('Screen 2'));
  });

  it('has a divider, then the two placement options', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} open onToggle={() => {}} onPlacement={() => {}} />);
    expect(html.indexOf('screens-picker__divider')).toBeLessThan(html.indexOf('Prioritize empty windows'));
    expect(html).toContain('Prioritize the main window');
    expect(html).toMatch(/checked=""[^>]*\/><span><strong>Prioritize empty windows/);
  });

  it('closed, it is just the button', () => {
    const html = renderToStaticMarkup(<ScreensMenu state={state} open={false} onToggle={() => {}} onPlacement={() => {}} />);
    expect(html).toContain('data-screens-button');
    expect(html).not.toContain('role="dialog"');
  });

  it('ends the wall toolbar, after the layout and snap controls, in both modes', () => {
    const view = readFileSync(new URL('../views/CommandCenterView.tsx', import.meta.url), 'utf8');
    const screens = view.indexOf('<ScreensControl mode={wall.layout.mode} />');
    expect(screens).toBeGreaterThan(-1);
    expect(view.indexOf('className="wall-snap-toggle"')).toBeGreaterThan(-1);
    expect(view.indexOf('className="wall-snap-toggle"')).toBeLessThan(screens);
    expect(view.indexOf('export function WallToolbar(')).toBeLessThan(screens);
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
    const html = renderToStaticMarkup(<ScreensMenu state={one} open onToggle={() => {}} onPlacement={() => {}} asking="space-2" />);
    expect(html).toContain('aria-label="Desktops: 2 of 3 on"');
    expect(html).toContain('aria-label="Desktops to use"');
    expect(html).toContain('aria-label="Desktop 3, opens when you get there"');
    expect(html).toContain('Accessibility');
    for (const label of ['Allow and switch', 'Open when I get there', 'switch to desktop 2']) expect(html).toContain(label);
    expect(html).toContain('class="spaces-demo"');
    expect(html).not.toContain('Connect another screen');
    // Chosen once, the mode is a view option, and a missing permission is explained.
    const chosen = renderToStaticMarkup(<ScreensMenu state={{ ...one, spaces: { ...one.spaces!, mode: 'switch' } }} open onToggle={() => {}} onPlacement={() => {}} />);
    expect(chosen).toContain('aria-label="How a desktop is reached"');
    expect(chosen).toContain('Accessibility is off for Nekko');
    expect(renderToStaticMarkup(<ScreensMenu state={state} open onToggle={() => {}} onPlacement={() => {}} />)).not.toContain('Desktops');
  });
});
