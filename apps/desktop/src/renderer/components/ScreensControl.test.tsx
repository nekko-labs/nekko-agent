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

  it('sits just left of the Monitors toggle, in Dynamic mode only', () => {
    const view = readFileSync(new URL('../views/CommandCenterView.tsx', import.meta.url), 'utf8');
    const screens = view.indexOf("wall.layout.mode === 'grid' && <ScreensControl />");
    expect(screens).toBeGreaterThan(-1);
    expect(screens).toBeLessThan(view.indexOf('<PanelIcon className="h-4 w-4" />Monitors'));
    expect(view.indexOf('wall-filter-segments')).toBeLessThan(screens);
  });
});
