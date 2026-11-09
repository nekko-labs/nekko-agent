import { describe, expect, it } from 'vitest';
import { findThemePreset } from '@nekko-agent/shared';
import { resolveThemeAppearance, themeModePatch, themePalettePatch } from './themeMode.js';
import { contrastRatio, parseColor } from './contrast.js';

const palettes = ['x-plum-white', 'nebula', 'terminal', 'nord', 'ember', 'x-forest-white', 'x-blueberry-white', 'autumn', 'winter'];
describe.each(palettes)('%s in both base modes', (id) => {
  it.each(['light', 'dark'] as const)('keeps %s when choosing a palette, and survives reload', (mode) => {
    const patch = themePalettePatch({ theme: mode }, id, mode !== 'dark');
    const result = resolveThemeAppearance(JSON.parse(JSON.stringify(patch)), mode !== 'dark');
    expect(result.mode).toBe(mode);
    expect(result.presetId).toBe(patch.themePreset);
    expect(result.accent).toBe(patch.accent);
    expect(result.accent2).toBe(patch.accent2);
  });
  it('round trips shipped colors and the selected palette', () => {
    const light = themePalettePatch({ theme: 'light' }, id, false);
    const dark = themeModePatch(light, 'dark', false);
    expect(themeModePatch(dark, 'light', true)).toEqual(light);
    expect(resolveThemeAppearance(dark, false).mode).toBe('dark');
  });
  it.each(['accent', 'accent2'] as const)('keeps a custom %s while adapting the other channel', (key) => {
    const start = { ...themePalettePatch({ theme: 'dark' }, id, false), [key]: '#123456' };
    const light = themeModePatch(start, 'light', true);
    expect(light[key]).toBe('#123456');
    expect(themeModePatch(light, 'dark', false)).toEqual(start);
  });
});
describe('legacy and default settings', () => {
  it('a fresh profile follows OS mode until explicitly toggled', () => {
    expect(resolveThemeAppearance({}, true).presetId).toBe('x-plum-dark');
    expect(resolveThemeAppearance({}, false).presetId).toBe('x-plum-white');
    const selected = themeModePatch({}, 'dark', false);
    expect(selected.theme).toBe('dark');
    expect(resolveThemeAppearance(selected, false).presetId).toBe('x-plum-dark');
  });
  it('keeps unlisted colourful presets on load', () => {
    expect(resolveThemeAppearance({ theme: 'light', themePreset: 'x-forest-colour' }, false).presetId).toBe('x-forest-colour');
  });
  it('a plain base theme keeps its custom accent', () => {
    expect(themeModePatch({ theme: 'dark', accent: '#123456' }, 'light', false)).toMatchObject({ theme: 'light', accent: '#123456', themePreset: undefined });
  });
  it('upgrades retired default colors before changing mode', () => {
    const legacy = { theme: 'dark' as const, themePreset: 'nebula', accent: '#a78bfa', accent2: '#f472b6' };
    expect(themeModePatch(legacy, 'light', true)).toEqual(themePalettePatch({ theme: 'light' }, 'nebula', true));
  });
  it('uses core light surfaces with readable accents for formerly dark-only palettes', () => {
    for (const id of ['nebula', 'terminal', 'nord', 'ember', 'autumn', 'winter']) {
      const p = themePalettePatch({ theme: 'light' }, id, false);
      for (const color of [p.accent!, p.accent2!]) {
        expect(contrastRatio(parseColor(color), parseColor('#f2f2f7')), id).toBeGreaterThanOrEqual(4.5);
      }
      expect(findThemePreset(p.themePreset)?.id).toBe(id);
    }
  });
});
