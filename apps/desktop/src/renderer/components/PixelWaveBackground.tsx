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

/** Nominal pitch between dots, in CSS pixels. */
export const DOT_CELL = 9;

/** Eligibility is deliberately independent of a welcome screen's model/setup UI. */
export function showEmptyAgentWave({ loaded, messages, running, composer, enabled, readOnly = false }: { loaded: boolean; messages: number; running: boolean; composer: boolean; enabled: boolean; readOnly?: boolean }): boolean {
  return loaded && messages === 0 && !running && !composer && enabled && !readOnly;
}

/**
 * Empty-agent decoration. A fine grid of pixel dots with a soft wave of
 * brightness drifting through it: every dot's opacity is recomputed each frame
 * from `sin(x/110 - t*1.4 + sin(y/150 + t*0.5) * 1.6)`, so rows phase against
 * each other and the pattern flows like water rather than sliding as one block.
 * Pane visibility, app focus and reduced motion hold it still.
 */
export function PixelWaveBackground({ wave, visible = true }: { wave: PixelWave; visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intersecting, setIntersecting] = React.useState(false);
  // The wave's clock and step count outlive a pause, so it resumes where it stopped.
  const clock = useRef({ t: 0, step: 0 });
  useEffect(() => {
    const element = ref.current, canvas = canvasRef.current;
    if (!element || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const speed = wave.speed ?? 0.8;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let last = 0, raf = 0;

    // Drawn in whole device pixels, so dots stay crisp and even at fractional display scaling.
    const draw = () => {
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale);
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const pitch = Math.max(1, Math.round(DOT_CELL * scale));
      const inset = Math.round(3 * scale);
      const small = Math.max(1, Math.round(2 * scale)), large = Math.max(1, Math.round(3 * scale));
      const { t } = clock.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      for (let row = 0; row * pitch < height; row++) {
        const y = row * DOT_CELL;
        const yPhase = Math.sin(y / 150 + t * 0.5) * 1.6;
        for (let col = 0; col * pitch < width; col++) {
          const amp = Math.sin((col * DOT_CELL) / 110 - t * 1.4 + yPhase);
          if (amp <= 0) continue;
          const a = amp ** 3 * wave.peak;
          if (a < 0.02) continue;
          ctx.globalAlpha = a;
          const s = a > wave.peak * 0.55 ? large : small;
          ctx.fillRect(col * pitch + inset, row * pitch + inset, s, s);
        }
      }
      ctx.globalAlpha = 1;
      // Tint the white dots: the gradient stays put while the wave moves through it.
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, wave.from);
      gradient.addColorStop(1, wave.to);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      canvas.dataset.step = String(clock.current.step);
    };
    const still = () => !visible || !intersecting || document.hidden || !document.hasFocus() || reduced.matches;
    // ~20 fps is enough for a continuous flow to read as smooth; lower looks staccato.
    const FRAME_MS = 50;
    const loop = (now: number) => {
      // Re-checked per frame too: a media query's change event can arrive late.
      if (still()) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      clock.current.t += (Math.min(now - last, 250) / 1000) * speed;
      clock.current.step += 1;
      last = now;
      draw();
    };
    const sync = () => {
      if (still()) { cancelAnimationFrame(raf); raf = 0; return; }
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };

    draw();
    sync();
    const resize = new ResizeObserver(() => draw());
    resize.observe(element);
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    observer.observe(element);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      observer.disconnect();
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
    };
  }, [wave.from, wave.to, wave.peak, wave.speed, visible, intersecting]);
  return <div ref={ref} className="pixel-wave-background" data-wave-paused={!visible || !intersecting || undefined} aria-hidden="true">
    <canvas ref={canvasRef} className="pixel-wave-canvas" />
  </div>;
}
