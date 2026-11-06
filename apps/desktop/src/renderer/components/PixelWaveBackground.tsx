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

/** A row's phase offset at time `t`: the inner sine that makes rows crest at different moments. */
export function wavePhase(row: number, t: number): number {
  return Math.sin((row * DOT_CELL) / 150 + t * 0.5) * 1.6;
}

/**
 * One dot's opacity in Travis's swell, `sin(x/110 - t*1.4 + phase)` cubed and
 * scaled to `peak`; troughs and near-invisible dots are 0.
 */
export function dotOpacity(col: number, t: number, phase: number, peak: number): number {
  const amp = Math.sin((col * DOT_CELL) / 110 - t * 1.4 + phase);
  if (amp <= 0) return 0;
  const a = amp ** 3 * peak;
  return a < 0.02 ? 0 : a;
}

/** `#rgb`, `#rrggbb` or `rgb()/rgba()` as channels, after the canvas has normalised it. */
function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const rgb = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return [rgb[0] ?? 255, rgb[1] ?? 255, rgb[2] ?? 255];
}

/**
 * The colour of every dot column, blending `from` to `to` across the pane.
 * Painting each column in its own colour replaces a full-canvas tint pass per
 * frame, which was most of the wave's raster cost.
 */
export function columnColors(ctx: Pick<CanvasRenderingContext2D, 'fillStyle'>, from: string, to: string, cols: number, pitch: number, width: number): string[] {
  ctx.fillStyle = from;
  const a = channels(String(ctx.fillStyle));
  ctx.fillStyle = to;
  const b = channels(String(ctx.fillStyle));
  return Array.from({ length: cols }, (_, col) => {
    const k = Math.min(1, (col * pitch) / Math.max(width - 1, 1));
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
  });
}

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

    // Dots land on whole device pixels, so they stay crisp at fractional display
    // scaling. Each column is painted in its slice of the gradient, so a frame
    // touches only the dots themselves: no full-canvas tint pass.
    let colors: string[] = [], colorsKey = '';
    let phases = new Float64Array(0);
    const draw = () => {
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale);
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const pitch = Math.max(1, Math.round(DOT_CELL * scale));
      const inset = Math.round(3 * scale);
      const small = Math.max(1, Math.round(2 * scale)), large = Math.max(1, Math.round(3 * scale));
      const cols = Math.ceil(width / pitch), rows = Math.ceil(height / pitch);
      const key = `${width}|${pitch}|${wave.from}|${wave.to}`;
      if (key !== colorsKey) { colors = columnColors(ctx, wave.from, wave.to, cols, pitch, width); colorsKey = key; }
      if (phases.length !== rows) phases = new Float64Array(rows);
      const { t } = clock.current;
      for (let row = 0; row < rows; row++) phases[row] = wavePhase(row, t);
      const bright = wave.peak * 0.55;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = colors[col];
        for (let row = 0; row < rows; row++) {
          const a = dotOpacity(col, t, phases[row], wave.peak);
          if (!a) continue;
          ctx.globalAlpha = a;
          const s = a > bright ? large : small;
          ctx.fillRect(col * pitch + inset, row * pitch + inset, s, s);
        }
      }
      ctx.globalAlpha = 1;
      canvas.dataset.step = String(clock.current.step);
    };
    const still = () => !visible || !intersecting || document.hidden || !document.hasFocus() || reduced.matches;
    // Travis's original pace: 15 frames a second reads as a continuous flow.
    const FRAME_MS = 66;
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
