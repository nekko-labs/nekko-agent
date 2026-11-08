import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import { matchSettingsPages } from '../settingsIndex.js';
import { stepTextScale, TEXT_SCALES } from '../textScale.js';
import { AnimationsSection } from './DesktopBehaviorSections.js';
import { StyleSection } from './StyleSection.js';
import { SETTINGS_GROUPS } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }), textScaleOf: (v?: number) => v ?? 100 }));

const render = (settings: Partial<AppSettings>) => renderToStaticMarkup(<AnimationsSection settings={settings as AppSettings} update={() => {}} />);
const renderStyle = (settings: Partial<AppSettings>) => renderToStaticMarkup(<StyleSection settings={settings as AppSettings} update={() => {}} />);

describe('Settings > Customize > Animations', () => {
  it('lives under Customize and remains discoverable by animations, accessibility and font size', () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toContain('customize');
    expect(matchSettingsPages('animations').map((p) => p.group)).toEqual(['customize']);
    expect(matchSettingsPages('accessibility').map((p) => p.group)).toEqual(['customize']);
    expect(matchSettingsPages('font size').map((p) => p.group)).toEqual(['customize']);
  });

  it('leaves the animation on until it is turned off', () => {
    expect(render({})).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: true })).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: false })).toMatch(/aria-checked="false"/);
  });

  it('has no text size of its own', () => {
    const html = render({ textScale: 125 });
    expect(html).toContain('>Animations<');
    expect(html).not.toContain('Text size');
    expect(html).not.toContain('data-text-size-preview');
  });
});

describe('Settings > Style text preview', () => {
  it('sits right after the code font and shows the current size, with nothing to apply', () => {
    const html = renderStyle({ textScale: 125 });
    expect(html.indexOf('Code font')).toBeLessThan(html.indexOf('data-text-size-preview'));
    expect(html.indexOf('data-text-size-preview')).toBeLessThan(html.indexOf('Add your own fonts'));
    expect(html).toContain('Preview at 125%');
    expect(html).not.toMatch(/Apply \d/);
  });
});

describe('stepTextScale', () => {
  it('walks every size and holds at the limits', () => {
    expect(TEXT_SCALES.slice(0, -1).map((s) => stepTextScale(s, 1))).toEqual(TEXT_SCALES.slice(1));
    expect(TEXT_SCALES.slice(1).map((s) => stepTextScale(s, -1))).toEqual(TEXT_SCALES.slice(0, -1));
    expect(stepTextScale(150, 1)).toBe(150);
    expect(stepTextScale(80, -1)).toBe(80);
  });

  it('moves a saved size between two steps onto a step', () => {
    expect(stepTextScale(95, 1)).toBe(100);
    expect(stepTextScale(95, -1)).toBe(90);
  });
});
