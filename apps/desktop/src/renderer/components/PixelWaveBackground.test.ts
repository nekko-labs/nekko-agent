import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { pixelWaveFor, showEmptyAgentWave, DOT_CELL } from './PixelWaveBackground.js';

describe('pixel wave', () => {
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
