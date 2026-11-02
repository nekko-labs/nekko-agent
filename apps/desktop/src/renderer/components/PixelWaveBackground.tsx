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

/**
 * One seamless tile, in dots: the wave repeats every `cols` columns and `rows`
 * rows, so copies of it cover a pane of any size with no edge or band.
 */
export const WAVE_TILE = { cols: 80, rows: 40, pitch: 9 } as const;

/** Opacity of the dot at a tile column and row; periodic in both. */
export function waveDot(col: number, row: number, peak: number): number {
  const w = Math.sin((2 * Math.PI * col) / WAVE_TILE.cols + Math.sin((2 * Math.PI * row) / WAVE_TILE.rows) * 1.6);
  const opacity = Math.max(0, w) ** 3 * peak;
  return opacity < 0.02 ? 0 : opacity;
}

/**
 * Rasterize the tile once, in white at whole device pixels so every dot is
 * crisp at any display scale; the pane's colour gradient is applied per paint.
 */
function waveTile(peak: number, scale: number): HTMLCanvasElement {
  const pitch = Math.max(1, Math.round(WAVE_TILE.pitch * scale));
  const tile = document.createElement('canvas');
  tile.width = WAVE_TILE.cols * pitch;
  tile.height = WAVE_TILE.rows * pitch;
  const ctx = tile.getContext('2d')!;
  ctx.fillStyle = '#fff';
  for (let col = 0; col < WAVE_TILE.cols; col++) {
    for (let row = 0; row < WAVE_TILE.rows; row++) {
      const opacity = waveDot(col, row, peak);
      if (!opacity) continue;
      const size = Math.max(1, Math.round((opacity > peak * 0.55 ? 3 : 2) * scale));
      ctx.globalAlpha = opacity;
      ctx.fillRect(col * pitch + Math.round(3 * scale), row * pitch + Math.round(3 * scale), size, size);
    }
  }
  return tile;
}

/** Eligibility is deliberately independent of a welcome screen's model/setup UI. */
export function showEmptyAgentWave({ loaded, messages, running, composer, enabled, readOnly = false }: { loaded: boolean; messages: number; running: boolean; composer: boolean; enabled: boolean; readOnly?: boolean }): boolean {
  return loaded && messages === 0 && !running && !composer && enabled && !readOnly;
}

/** Milliseconds between one-column steps: about 48 CSS px a second at the default speed. */
export const waveStepMs = (speed = 0.8) => Math.round((WAVE_TILE.pitch / (60 * speed)) * 1000);

/**
 * Empty-agent decoration only. The pattern advances one dot column per step,
 * like a dot-matrix sign: dots never leave the grid, and each step only copies
 * the pre-rendered tile. Pane visibility, app focus and reduced motion hold it.
 */
export function PixelWaveBackground({ wave, visible = true }: { wave: PixelWave; visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [intersecting, setIntersecting] = React.useState(false);
  const step = useRef(0);
  const paint = useRef<() => void>(() => {});
  useEffect(() => {
    const element = ref.current, canvas = canvasRef.current;
    if (!element || !canvas) return;
    let tile: HTMLCanvasElement | null = null, tileScale = 0;
    paint.current = () => {
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale);
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      if (!tile || tileScale !== scale) { tile = waveTile(wave.peak, scale); tileScale = scale; }
      const ctx = canvas.getContext('2d')!;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      const pitch = tile.width / WAVE_TILE.cols;
      const shift = (step.current % WAVE_TILE.cols) * pitch;
      for (let y = 0; y < height; y += tile.height) {
        for (let x = -shift; x < width; x += tile.width) ctx.drawImage(tile, x, y);
      }
      // Tint the white dots: the gradient stays put while the wave moves through it.
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, wave.from);
      gradient.addColorStop(1, wave.to);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      canvas.dataset.step = String(step.current);
    };
    paint.current();
    const resize = new ResizeObserver(() => paint.current());
    resize.observe(element);
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    observer.observe(element);
    return () => { resize.disconnect(); observer.disconnect(); };
  }, [wave.from, wave.to, wave.peak]);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    const still = () => !visible || !intersecting || document.hidden || !document.hasFocus() || reduced.matches;
    const schedule = () => {
      window.clearInterval(timer);
      timer = 0;
      if (still()) return;
      // Re-checked per step too: a media query's change event can arrive late.
      timer = window.setInterval(() => {
        if (still()) return schedule();
        step.current += 1;
        paint.current();
      }, waveStepMs(wave.speed));
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
    <canvas ref={canvasRef} className="pixel-wave-canvas" />
  </div>;
}
