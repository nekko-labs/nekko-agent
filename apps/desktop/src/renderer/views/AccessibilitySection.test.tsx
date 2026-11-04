import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@nekko-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import { matchSettingsPages } from '../settingsIndex.js';
import { AccessibilitySection } from './DesktopBehaviorSections.js';
import { SETTINGS_GROUPS } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }), textScaleOf: () => 1 }));

const render = (settings: Partial<AppSettings>) => renderToStaticMarkup(<AccessibilitySection settings={settings as AppSettings} update={() => {}} />);

describe('Settings > Accessibility', () => {
  it('has its own group, found by searching for it', () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toContain('accessibility');
    expect(matchSettingsPages('accessibility').map((p) => p.group)).toEqual(['accessibility']);
  });

  it('leaves the animation on until it is turned off', () => {
    expect(render({})).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: true })).toMatch(/aria-checked="true"/);
    expect(render({ agentActivityAnimation: false })).toMatch(/aria-checked="false"/);
  });
});
