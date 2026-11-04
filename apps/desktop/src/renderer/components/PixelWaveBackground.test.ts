import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { pixelWaveFor, showEmptyAgentWave, DOT_CELL, dotOpacity, wavePhase, columnColors } from './PixelWaveBackground.js';

describe('pixel wave', () => {
  const field = (t: number, cols = 80, rows = 40, peak = 0.26) =>
    Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => dotOpacity(col, t, wavePhase(row, t), peak)));

  it('keeps dots faint and leaves troughs empty', () => {
    const dots = field(1.3).flat();
    expect(Math.max(...dots)).toBeLessThanOrEqual(0.26);
    expect(dots.filter((d) => d === 0).length).toBeGreaterThan(dots.length / 3);
    expect(dots.every((d) => d === 0 || d >= 0.02)).toBe(true);
  });

  it('flows: rows crest at different moments and the field changes over time', () => {
    const a = field(0), b = field(0.4);
    expect(a[0].join()).not.toBe(a[10].join());
    expect(a[5].join()).not.toBe(b[5].join());
  });

  it('paints each column in its slice of the gradient, whatever form the colours take', () => {
    const ctx = { _v: '', get fillStyle() { return this._v; }, set fillStyle(v: string) { this._v = v === 'white' ? '#ffffff' : v; } };
    expect(columnColors(ctx as never, '#453a92', '#9d8ce6', 3, 10, 21)).toEqual(['rgb(69,58,146)', 'rgb(113,99,188)', 'rgb(157,140,230)']);
    expect(columnColors(ctx as never, 'white', 'rgba(0, 0, 0, 0.5)', 2, 10, 11)).toEqual(['rgb(255,255,255)', 'rgb(0,0,0)']);
  });

  it('keeps the same 9-pixel grid the marketing site uses', () => {
    expect(DOT_CELL).toBe(9);
  });

  it('only decorates loaded empty agent windows, never running turns or the shared composer', () => {
    const empty = { loaded: true, messages: 0, running: false, composer: false, enabled: true };
    expect(showEmptyAgentWave(empty)).toBe(true);
    for (const patch of [{ loaded: false }, { messages: 1 }, { running: true }, { composer: true }, { enabled: false }, { readOnly: true }]) {
      expect(showEmptyAgentWave({ ...empty, ...patch })).toBe(false);
    }
  });

  it('dims every experimental wave and halves its motion speed without changing colours', () => {
    for (const preset of THEME_PRESETS.filter((p) => p.group === 'experimental')) {
      expect(preset.wave).toBeDefined();
      expect(pixelWaveFor(preset.id)).toEqual({ ...preset.wave, peak: preset.wave!.peak * 0.6, speed: 0.4 });
    }
    expect(pixelWaveFor('lilac')).toEqual({ from: '#453a92', to: '#9d8ce6', peak: 0.26 });
    expect(pixelWaveFor('lavender')).toEqual({ from: '#ffffff', to: '#ffffff', peak: 0.34 });
  });

  it('only themes with a wave draw one', () => {
    expect(pixelWaveFor('lilac')).not.toBeNull();
    expect(pixelWaveFor('lavender')).not.toBeNull();
    expect(pixelWaveFor('x-cyber-dark')).not.toBeNull();
    expect(pixelWaveFor('light')).toBeNull();
    expect(pixelWaveFor(undefined)).toBeNull();
  });
});
