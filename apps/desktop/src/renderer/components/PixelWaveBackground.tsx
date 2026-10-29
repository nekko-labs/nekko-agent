import React, { useEffect, useRef } from 'react';
import { findThemePreset } from '@nekko-agent/shared';

/** Dot colours blending `from` to `to` left to right, and the strongest dot's opacity. */
export interface PixelWave { from: string; to: string; peak: number; speed?: number }

/**
 * The wave a preset draws, or null for presets without one. Lilac draws the
 * logo's indigo-to-lavender gradient; Lavender, whose ground is already that
 * lavender, draws white dots; Experimental presets carry their own colours.
 */
export function pixelWaveFor(presetId: string | undefined): PixelWave | null {
  if (presetId === 'lilac') return { from: '#453a92', to: '#9d8ce6', peak: 0.26 };
  if (presetId === 'lavender') return { from: '#ffffff', to: '#ffffff', peak: 0.34 };
  const preset = findThemePreset(presetId);
  if (!preset?.wave) return null;
  return preset.group === 'experimental'
    ? { ...preset.wave, peak: preset.wave.peak * 0.6, speed: 0.4 }
    : preset.wave;
}

/** One small, shared texture, independent of panel and monitor resolution. */
export const WAVE_TEXTURE = { width: 720, height: 360, pitch: 9 } as const;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Rasterized by Chromium once; motion only translates this image, never its dots. */
export function waveTexture({ from, to, peak }: PixelWave): string {
  const a = rgb(from), b = rgb(to);
  const dots: string[] = [];
  for (let x = 0; x < WAVE_TEXTURE.width; x += WAVE_TEXTURE.pitch) {
    const k = x / WAVE_TEXTURE.width;
    const color = `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
    for (let y = 0; y < WAVE_TEXTURE.height; y += WAVE_TEXTURE.pitch) {
      const w = Math.sin(x / 110 + Math.sin(y / 150) * 1.6);
      // Bake a soft edge into the texture instead of adding a composited mask.
      const fade = Math.min(1, x / 54, (WAVE_TEXTURE.width - x) / 54)
        * Math.min(1, y / 54, (WAVE_TEXTURE.height - y) / 54);
      const opacity = Math.max(0, w) ** 3 * peak * fade;
      if (opacity < 0.02) continue;
      const size = opacity > peak * 0.55 ? 3 : 2;
      dots.push(`<rect x="${x + 3}" y="${y + 3}" width="${size}" height="${size}" fill="${color}" opacity="${opacity.toFixed(3)}"/>`);
    }
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">${dots.join('')}</svg>`)}`;
}

/** Eligibility is deliberately independent of a welcome screen's model/setup UI. */
export function showEmptyAgentWave({ loaded, messages, running, composer, enabled, readOnly = false }: { loaded: boolean; messages: number; running: boolean; composer: boolean; enabled: boolean; readOnly?: boolean }): boolean {
  return loaded && messages === 0 && !running && !composer && enabled && !readOnly;
}

/** Empty-agent decoration only. Pane visibility and app activity pause CSS motion. */
export function PixelWaveBackground({ wave, visible = true }: { wave: PixelWave; visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [intersecting, setIntersecting] = React.useState(false);
  const texture = React.useMemo(() => waveTexture(wave), [wave.from, wave.to, wave.peak]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    // A stepped CSS animation can still tick Chromium every vsync. Hold it and
    // advance the transform only when the next precomputed step changes.
    const schedule = () => {
      window.clearInterval(timer);
      timer = 0;
      if (!visible || !intersecting || document.hidden || !document.hasFocus() || reduced.matches) return;
      const animation = ref.current?.querySelector('img')?.getAnimations()[0];
      if (!animation) return;
      const stepMs = 18_000 / (wave.speed ?? 0.8) / 36;
      timer = window.setInterval(() => {
        animation.currentTime = Number(animation.currentTime ?? 0) + stepMs;
      }, stepMs);
    };
    schedule();
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', schedule);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', schedule);
      document.removeEventListener('visibilitychange', schedule);
      reduced.removeEventListener('change', schedule);
    };
  }, [visible, intersecting, wave.speed]);
  return <div ref={ref} className="pixel-wave-background" data-wave-paused={!visible || !intersecting || undefined} aria-hidden="true">
    <img className="pixel-wave-texture" src={texture} width={720} height={360} alt="" draggable={false}
      style={{ animationDuration: `${18 / (wave.speed ?? 0.8)}s` }} />
  </div>;
}
