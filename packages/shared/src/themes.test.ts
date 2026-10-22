import { describe, expect, it } from 'vitest';
import { THEME_PRESETS, currentPresetAccent, type ThemePreset } from './themes.js';

describe('currentPresetAccent', () => {
  it('upgrades accents a retuned preset used to save', () => {
    expect(currentPresetAccent('nebula', '#a78bfa')).toBe('#9d8ce6');
    expect(currentPresetAccent('nebula', '#F472B6')).toBe('#d98bb6');
    expect(currentPresetAccent('terminal', '#22c55e')).toBe('#3fb96a');
  });
  it('keeps the user’s own colors and other presets untouched', () => {
    expect(currentPresetAccent('nebula', '#ff0000')).toBe('#ff0000');
    expect(currentPresetAccent('dark', '#a78bfa')).toBe('#a78bfa');
    expect(currentPresetAccent(undefined, '#a78bfa')).toBe('#a78bfa');
    expect(currentPresetAccent('nebula', undefined)).toBeUndefined();
  });
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe('THEME_PRESETS', () => {
  it('contains the v1 catalog with no duplicate ids', () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('system');
    expect(ids).toContain('light');
    expect(ids).toContain('dark');
    expect(ids).toContain('nebula');
    expect(ids).toContain('terminal');
    expect(ids).toContain('nord');
    expect(ids).toContain('solar');
    expect(ids).toContain('ember');
    expect(ids).toContain('autumn');
  });

  it('Ember and Autumn preserve the original dark surfaces', () => {
    for (const id of ['ember', 'autumn']) {
      const preset = THEME_PRESETS.find((p) => p.id === id)!;
      expect(preset.mode).toBe('dark');
      for (const key of ['paper', 'surface', 'surface2', 'ink', 'inkSoft', 'inkFaint', 'line'] as const) {
        expect(preset[key]).toBeUndefined();
      }
    }
  });

  it('every preset declares a mode, a label, and at least 3 swatch colors', () => {
    for (const p of THEME_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.mode).toMatch(/^(light|dark|system)$/);
      expect(p.swatch).toBeInstanceOf(Array);
      expect(p.swatch.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every preset uses valid 6-digit hex for accents and swatches', () => {
    for (const p of THEME_PRESETS) {
      expect(p.accent).toMatch(HEX_RE);
      expect(p.accent2).toMatch(HEX_RE);
      for (const color of p.swatch) {
        expect(color).toMatch(HEX_RE);
      }
    }
  });

  it('no two presets render identically', () => {
    // Nebula once shipped as a byte-for-byte copy of Dark, so the picker showed
    // two tiles that did the same thing. A preset earns its slot by differing in
    // mode, accent, or surface tokens.
    const fingerprints = THEME_PRESETS.map((p) =>
      [p.mode, p.accent, p.accent2, p.paper, p.surface, p.surface2, p.ink, p.inkSoft, p.inkFaint, p.line].join('|'),
    );
    expect(new Set(fingerprints).size).toBe(THEME_PRESETS.length);
  });

  it('surface/ink overrides, when present, are valid 6-digit hex', () => {
    const overrideKeys: (keyof ThemePreset)[] = [
      'paper',
      'surface',
      'surface2',
      'ink',
      'inkSoft',
      'inkFaint',
      'line',
    ];
    for (const p of THEME_PRESETS) {
      for (const key of overrideKeys) {
        const value = p[key];
        if (value != null) {
          expect(value).toMatch(HEX_RE);
        }
      }
    }
  });
});
