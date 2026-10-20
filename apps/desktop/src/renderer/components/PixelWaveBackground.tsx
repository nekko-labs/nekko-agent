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

/** Grid pitch in CSS pixels: one dot per cell. */
const CELL = 9;
/** Frame interval while the window is in front (~10 fps) and while it is not (~4 fps). The wave drifts slowly, so 10 fps reads as smooth; every frame costs a full-window composite. */
const ACTIVE_MS = 100;
const BACKGROUND_MS = 250;

/**
 * The wave's brightness for every cell at time `t`, written into `out` (one
 * value per cell, row-major). The wave is sin(x/110 - 1.4t + 1.6 sin(y/150 + 0.5t)):
 * the column part and the row part are each worked out once, and the angle-sum
 * identity combines them, so the per-cell work is two multiplies and an add
 * instead of two sines.
 */
export function waveField(cols: number, rows: number, t: number, peak: number, out: Float32Array, colSin: Float32Array, colCos: Float32Array): void {
  for (let r = 0; r < rows; r++) {
    const b = Math.sin((r * CELL) / 150 + t * 0.5) * 1.6 - t * 1.4;
    const sb = Math.sin(b), cb = Math.cos(b);
    const row = r * cols;
    for (let c = 0; c < cols; c++) {
      const wave = colSin[c] * cb + colCos[c] * sb; // sin(a + b)
      out[row + c] = wave > 0 ? wave * wave * wave * peak : 0;
    }
  }
}

/**
 * The marketing site's dot-matrix swell (nekkoagent.com), for the presets in
 * `pixelWaveFor`: a fine grid of pixel dots that mostly sits invisible, with
 * a soft wave of brightness drifting through it. Decorative only: it never
 * takes input, runs at ~10 fps while Nekko is the active window and ~4 fps
 * behind other windows, stops while hidden, and holds one still frame for
 * reduced motion. Settings → Appearance can turn it off entirely.
 *
 * Cost matters because it runs all the time: colours are built once per
 * column (opacity goes through globalAlpha, not a new colour string per dot),
 * the trigonometry is precomputed per row and column, and the canvas is drawn
 * at one pixel per CSS pixel with crisp scaling rather than at device
 * resolution.
 */
export function PixelWaveBackground({ wave: { from, to, peak } }: { wave: PixelWave }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [r0, g0, b0] = rgb(from), [r1, g1, b1] = rgb(to);
    let w = 0, h = 0, cols = 0, rows = 0, t = 0, last = 0, raf = 0;
    let colColor: string[] = [], colSin = new Float32Array(0), colCos = new Float32Array(0), field = new Float32Array(0);
    let focused = document.hasFocus();

    const size = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w; canvas.height = h;
      ctx.imageSmoothingEnabled = false;
      cols = Math.ceil(w / CELL); rows = Math.ceil(h / CELL);
      colColor = []; colSin = new Float32Array(cols); colCos = new Float32Array(cols);
      for (let c = 0; c < cols; c++) {
        const x = c * CELL, k = x / Math.max(w, 1); // 0 = the `from` colour, 1 = the `to` colour
        colColor.push(`rgb(${Math.round(r0 + (r1 - r0) * k)},${Math.round(g0 + (g1 - g0) * k)},${Math.round(b0 + (b1 - b0) * k)})`);
        colSin[c] = Math.sin(x / 110); colCos[c] = Math.cos(x / 110);
      }
      field = new Float32Array(cols * rows);
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      waveField(cols, rows, t, peak, field, colSin, colCos);
      const big = peak * 0.55;
      // Column by column so the fill colour is set once per column.
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = colColor[c];
        const x = c * CELL;
        for (let r = 0; r < rows; r++) {
          const a = field[r * cols + c];
          if (a < 0.02) continue;
          const s = a > big ? 3 : 2, o = (CELL - s) >> 1;
          ctx.globalAlpha = a;
          ctx.fillRect(x + o, r * CELL + o, s, s);
        }
      }
      ctx.globalAlpha = 1;
    };
    // A timer waits between frames and asks for one animation frame only when it
    // is time to draw. Requesting a frame every vsync (and skipping most of them)
    // keeps the compositor and GPU process producing 60 frames a second for 15
    // drawn ones; that idle churn cost more than the drawing itself.
    let timer = 0;
    const frame = (now: number) => {
      raf = 0;
      t += (Math.min(now - last, 250) / 1000) * 0.8;
      last = now;
      draw();
      schedule();
    };
    const schedule = () => {
      timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, focused ? ACTIVE_MS : BACKGROUND_MS);
    };
    const start = () => {
      if (timer || raf || reduced || document.hidden) return;
      last = performance.now();
      schedule();
    };
    const stop = () => { window.clearTimeout(timer); cancelAnimationFrame(raf); timer = 0; raf = 0; };
    const onResize = () => { size(); draw(); };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onFocus = () => { focused = true; };
    const onBlur = () => { focused = false; };

    size(); draw(); start();
    window.addEventListener('resize', onResize);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [from, to, peak]);

  return <canvas ref={ref} className="pixel-wave-background" aria-hidden="true" />;
}
