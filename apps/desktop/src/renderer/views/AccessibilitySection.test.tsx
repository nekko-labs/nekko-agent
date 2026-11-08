import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import { matchSettingsPages } from '../settingsIndex.js';
import { stepTextScale, TEXT_SCALES } from '../textScale.js';
import { AccessibilitySection } from './DesktopBehaviorSections.js';
import { SETTINGS_GROUPS } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }), textScaleOf: (v?: number) => v ?? 100 }));

const render = (settings: Partial<AppSettings>) => renderToStaticMarkup(<AccessibilitySection settings={settings as AppSettings} update={() => {}} />);
const stepper = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

describe('Settings > Customize > Accessibility', () => {
  it('lives under Customize and remains discoverable by accessibility and font size', () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toContain('customize');
    expect(matchSettingsPages('accessibility').map((p) => p.group)).toEqual(['customize']);
    expect(matchSettingsPages('font size').map((p) => p.group)).toEqual(['customize']);
  });

  it('leaves the animation on until it is turned off', () => {
    expect(render({})).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: true })).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: false })).toMatch(/aria-checked="false"/);
  });

  it('puts text size before the animation toggle', () => {
    const html = render({});
    expect(html.indexOf('Text size')).toBeGreaterThan(-1);
    expect(html.indexOf('Text size')).toBeLessThan(html.indexOf('Agent activity animation'));
  });

  it('stops the stepper at each limit and offers nothing to apply at rest', () => {
    expect(stepper(render({ textScale: 80 }), 'Decrease text size')).toMatch(/disabled/);
    expect(stepper(render({ textScale: 80 }), 'Increase text size')).not.toMatch(/disabled/);
    expect(stepper(render({ textScale: 150 }), 'Increase text size')).toMatch(/disabled/);
    expect(stepper(render({ textScale: 150 }), 'Decrease text size')).not.toMatch(/disabled/);
    expect(render({ textScale: 125 })).not.toMatch(/Apply \d/);
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
