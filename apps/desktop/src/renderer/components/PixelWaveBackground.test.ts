import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { pixelWaveFor, waveTexture, WAVE_TEXTURE, showEmptyAgentWave } from './PixelWaveBackground.js';

describe('pixel wave', () => {
  it('builds one bounded deterministic texture, not an animated SVG or sprite sheet', () => {
    const wave = pixelWaveFor('lilac')!;
    const svg = decodeURIComponent(waveTexture(wave).split(',').slice(1).join(','));
    expect(WAVE_TEXTURE).toEqual({ width: 720, height: 360, pitch: 9 });
    expect(svg).toContain('viewBox="0 0 720 360"');
    expect(svg).not.toMatch(/animate|script|filter|foreignObject/);
    expect(waveTexture(wave)).toBe(waveTexture(wave));
  });

  it('only decorates loaded empty agent windows, never running turns or the shared composer', () => {
    const empty = { loaded: true, messages: 0, running: false, composer: false, enabled: true };
    expect(showEmptyAgentWave(empty)).toBe(true);
    for (const patch of [{ loaded: false }, { messages: 1 }, { running: true }, { composer: true }, { enabled: false }]) {
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
