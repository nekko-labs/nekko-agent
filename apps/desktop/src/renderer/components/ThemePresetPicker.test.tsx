import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../i18n.js', () => ({ useT: () => (key: string) => key }));
vi.mock('@nekko-agent/shared', () => import('../../../../../packages/shared/src/themes.js'));
import { slicedSwatch, ThemePresetPicker } from './ThemePresetPicker.js';
import type { AppSettings } from '@nekko-agent/shared';

describe('theme palette slices', () => {
  it('uses adjacent hard stops rather than blending colors', () => {
    expect(slicedSwatch(['#111', '#222', '#333', '#444'])).toBe('conic-gradient(from 0deg, #111 0% 25%, #222 25% 50%, #333 50% 75%, #444 75% 100%)');
  });
  it('shows the Nekko light/dark toggle above the curated themes, with Spooky and Winter under Seasonal', () => {
    const markup = renderToStaticMarkup(<ThemePresetPicker settings={{ theme: 'dark', accent: '#6d5efc' } as AppSettings} update={() => {}} />);
    expect(markup).toContain('role="switch" aria-label="settings.themeDark" aria-checked="true"');
    expect(markup.indexOf('class="theme-mode-toggle"')).toBeLessThan(markup.indexOf('aria-label="Themes"'));
    for (const name of ['Nekko', 'Nebula', 'Terminal', 'Nord', 'Ember', 'Forest', 'Blueberry']) expect(markup).toContain(`title="${name}"`);
    for (const gone of ['Solar', 'Lilac', 'Lavender', 'Raspberry', 'Cyber', 'Tidepool', 'Colourful']) expect(markup).not.toContain(`title="${gone}`);
    expect(markup.match(/title="Spooky"/g)).toHaveLength(1);
    expect(markup.match(/title="Winter"/g)).toHaveLength(1);
    expect(markup.indexOf('title="Winter"')).toBeGreaterThan(markup.indexOf('aria-label="Seasonal"'));
    expect(markup.indexOf('aria-label="Seasonal"')).toBeGreaterThan(markup.indexOf('aria-label="Themes"'));
  });
  it('selects a family directly without a separate versions submenu', () => {
    const markup = renderToStaticMarkup(<ThemePresetPicker settings={{ theme: 'light', themePreset: 'x-forest-white' } as AppSettings} update={() => {}} />);
    expect(markup).toContain('title="Forest" role="radio" aria-checked="true"');
    expect(markup).not.toContain('Forest versions');
    expect(markup).not.toContain('x-forest-colour');
    expect(markup).not.toContain('Colourful');
  });
  it('renders preset and custom circles with solid slices', () => {
    const markup = renderToStaticMarkup(<ThemePresetPicker settings={{ theme: 'dark', accent: '#6d5efc' } as AppSettings} update={() => {}} />);
    expect(markup).toContain('conic-gradient');
    expect(markup).toContain('#f87171 0% 16.666666666666668%');
    expect(markup).toContain('role="radiogroup"');
  });
});
