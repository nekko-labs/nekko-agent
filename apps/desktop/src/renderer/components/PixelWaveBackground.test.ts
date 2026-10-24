import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { pixelWaveFor, waveField } from './PixelWaveBackground.js';

describe('pixel wave', () => {
  it('draws the same wave as the original per-cell formula', () => {
    // The original drew, for every cell, sin(x/110 - 1.4t + 1.6 sin(y/150 + 0.5t)), cubed and scaled by peak.
    const CELL = 9, cols = 40, rows = 25, peak = 0.3;
    const colSin = new Float32Array(cols), colCos = new Float32Array(cols);
    for (let c = 0; c < cols; c++) { colSin[c] = Math.sin((c * CELL) / 110); colCos[c] = Math.cos((c * CELL) / 110); }
    const out = new Float32Array(cols * rows);
    for (const t of [0, 1.7, 42.3]) {
      waveField(cols, rows, t, peak, out, colSin, colCos);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const w = Math.sin((c * CELL) / 110 - t * 1.4 + Math.sin((r * CELL) / 150 + t * 0.5) * 1.6);
          expect(out[r * cols + c]).toBeCloseTo(Math.max(0, w) ** 3 * peak, 5);
        }
      }
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
