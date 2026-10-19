import React, { useEffect, useRef } from 'react';
import { findThemePreset } from '@nekko-agent/shared';

/** Dot colours blending `from` to `to` left to right, and the strongest dot's opacity. */
export interface PixelWave { from: string; to: string; peak: number }

/**
 * The wave a preset draws, or null for presets without one. Lilac draws the
 * logo's indigo-to-lavender gradient; Lavender, whose ground is already that
 * lavender, draws white dots; Experimental presets carry their own colours.
 */
export function pixelWaveFor(presetId: string | undefined): PixelWave | null {
  if (presetId === 'lilac') return { from: '#453a92', to: '#9d8ce6', peak: 0.26 };
  if (presetId === 'lavender') return { from: '#ffffff', to: '#ffffff', peak: 0.34 };
  return findThemePreset(presetId)?.wave ?? null;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * The marketing site's dot-matrix swell (nekkoagent.com), for the presets in
 * `pixelWaveFor`: a fine grid of pixel dots that mostly sits invisible, with
 * a soft wave of brightness drifting through it. Decorative only: it never takes input,
 * runs at ~15 fps, stops while the window is hidden, and holds one still frame
 * for reduced motion.
 */
export function PixelWaveBackground({ wave: { from, to, peak } }: { wave: PixelWave }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 9;
    const [r0, g0, b0] = rgb(from), [r1, g1, b1] = rgb(to);
    let w = 0, h = 0, t = 0, last = 0, raf = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let y = 0; y < h; y += CELL) {
        for (let x = 0; x < w; x += CELL) {
          const wave = Math.sin(x / 110 - t * 1.4 + Math.sin(y / 150 + t * 0.5) * 1.6);
          const a = Math.max(0, wave) ** 3 * peak;
          if (a < 0.02) continue;
          const s = a > peak * 0.55 ? 3 : 2;
          const k = x / Math.max(w, 1); // 0 = the `from` colour, 1 = the `to` colour
          ctx.fillStyle = `rgba(${Math.round(r0 + (r1 - r0) * k)},${Math.round(g0 + (g1 - g0) * k)},${Math.round(b0 + (b1 - b0) * k)},${a.toFixed(3)})`;
          ctx.fillRect(Math.round(x + (CELL - s) / 2), Math.round(y + (CELL - s) / 2), s, s);
        }
      }
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 66) return;
      t += ((now - last) / 1000) * 0.8;
      last = now;
      draw();
    };
    const start = () => {
      if (raf || reduced || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onResize = () => { size(); draw(); };
    const onVisibility = () => (document.hidden ? stop() : start());

    size(); draw(); start();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [from, to, peak]);

  return <canvas ref={ref} className="pixel-wave-background" aria-hidden="true" />;
}
