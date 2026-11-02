import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { pixelWaveFor, waveDot, waveStepMs, WAVE_TILE, showEmptyAgentWave } from './PixelWaveBackground.js';

describe('pixel wave', () => {
  it('tiles seamlessly, so copies cover a pane of any size without a band or edge', () => {
    const { peak } = pixelWaveFor('lilac')!;
    expect(WAVE_TILE).toEqual({ cols: 80, rows: 40, pitch: 9 });
    for (let row = 0; row < WAVE_TILE.rows; row++) {
      expect(waveDot(WAVE_TILE.cols, row, peak)).toBeCloseTo(waveDot(0, row, peak), 9);
    }
    for (let col = 0; col < WAVE_TILE.cols; col++) {
      expect(waveDot(col, WAVE_TILE.rows, peak)).toBeCloseTo(waveDot(col, 0, peak), 9);
    }
  });

  it('keeps dots faint and leaves troughs empty', () => {
    const peak = 0.26;
    const dots = Array.from({ length: WAVE_TILE.cols * WAVE_TILE.rows }, (_, i) => waveDot(i % WAVE_TILE.cols, Math.floor(i / WAVE_TILE.cols), peak));
    expect(Math.max(...dots)).toBeLessThanOrEqual(peak);
    expect(dots.filter((d) => d === 0).length).toBeGreaterThan(dots.length / 3);
    expect(dots.every((d) => d === 0 || d >= 0.02)).toBe(true);
  });

  it('steps one dot column a few times a second, slower for experimental themes', () => {
    expect(waveStepMs()).toBe(188);
    expect(waveStepMs(0.4)).toBe(375);
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
