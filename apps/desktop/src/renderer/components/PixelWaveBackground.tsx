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
  useEffect(() => {
    const element = ref.current, canvas = canvasRef.current;
    if (!element || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const speed = wave.speed ?? 0.8;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0, h = 0, t = 0, last = 0, raf = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = element.clientWidth;
      h = element.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    const draw = () => {
      if (!w || !h) return;
      ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      for (let y = 0; y < h; y += DOT_CELL) {
        const yPhase = Math.sin(y / 150 + t * 0.5) * 1.6;
        for (let x = 0; x < w; x += DOT_CELL) {
          const amp = Math.sin(x / 110 - t * 1.4 + yPhase);
          if (amp <= 0) continue;
          const a = amp ** 3 * wave.peak;
          if (a < 0.02) continue;
          const s = a > wave.peak * 0.55 ? 3 : 2;
          ctx.globalAlpha = a;
          ctx.fillRect(Math.round(x + (DOT_CELL - s) / 2), Math.round(y + (DOT_CELL - s) / 2), s, s);
        }
      }
      ctx.globalAlpha = 1;
      // Tint the white dots: the gradient stays put while the wave moves through it.
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, wave.from);
      gradient.addColorStop(1, wave.to);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    };
    const still = () => !visible || !intersecting || document.hidden || !document.hasFocus() || reduced.matches;
    // ~20 fps is enough for a continuous flow to read as smooth; dropping lower looks staccato.
    const FRAME_MS = 50;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (still()) { last = now; return; }
      if (now - last < FRAME_MS) return;
      t += ((now - last) / 1000) * speed;
      last = now;
      draw();
    };
    const start = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

    size();
    draw();
    start();

    const resize = new ResizeObserver(() => { size(); draw(); });
    resize.observe(element);
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    observer.observe(element);
    const onFocusChange = () => { if (still()) stop(); else start(); };
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    document.addEventListener('visibilitychange', onFocusChange);
    reduced.addEventListener('change', onFocusChange);
    return () => {
      stop();
      resize.disconnect();
      observer.disconnect();
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      document.removeEventListener('visibilitychange', onFocusChange);
      reduced.removeEventListener('change', onFocusChange);
    };
  }, [wave.from, wave.to, wave.peak, wave.speed, visible, intersecting]);
  return <div ref={ref} className="pixel-wave-background" data-wave-paused={!visible || !intersecting || undefined} aria-hidden="true">
    <canvas ref={canvasRef} className="pixel-wave-canvas" />
  </div>;
}
