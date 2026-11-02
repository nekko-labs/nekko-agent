import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../displays.js';

/**
 * Switching rail views swaps the whole main area, and a new view's first
 * frames settle as its data arrives. ViewReveal covers that in chunky pixel
 * blocks and resolves them away: each block steps down through ASCII shades
 * (█ ▓ ▒ ░, then clear), from the centre out with some jitter, the dissolving
 * front tinted with the theme accent over a faint aura.
 */
export const REVEAL = { cell: 16, holdMs: 60, dissolveMs: 240 } as const;

/** 0..1: when a block starts clearing. Centre first, jittered so no ring shows. */
export function revealOrder(col: number, row: number, cols: number, rows: number): number {
  const dx = col + 0.5 - cols / 2, dy = row + 0.5 - rows / 2;
  const dist = Math.min(1, Math.hypot(dx, dy) / Math.hypot(cols / 2, rows / 2));
  let h = (col * 374761393 + row * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const noise = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  return 0.6 * dist + 0.4 * noise;
}

/** The shade a block shows at timeline progress 0..1: 0 is █ (solid) through 3 ░, 4 is clear. */
export function revealShade(order: number, progress: number): number {
  const local = (progress - order * 0.6) / 0.4;
  if (local <= 0) return 0;
  if (local >= 1) return 4;
  return 1 + Math.min(2, Math.floor(local * 3));
}

export function ViewReveal({ view }: { view: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = useRef(view);
  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host || prefersReducedMotion()) return;
    const scale = window.devicePixelRatio || 1;
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d')!;
    const style = getComputedStyle(document.documentElement);
    const paper = style.getPropertyValue('--paper').trim() || '#0c0c11';
    const accent = style.getPropertyValue('--accent').trim() || '#8b7dff';
    const cell = Math.round(REVEAL.cell * scale);
    const cols = Math.ceil(canvas.width / cell), rows = Math.ceil(canvas.height / cell);
    const order = Float32Array.from({ length: cols * rows }, (_, i) => revealOrder(i % cols, Math.floor(i / cols), cols, rows));
    const aura = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, Math.hypot(canvas.width, canvas.height) / 2);
    aura.addColorStop(0, accent);
    aura.addColorStop(1, 'transparent');
    // Per shade: inset of the block within its cell, colour and opacity.
    const shades = [
      { inset: 0, color: paper, alpha: 0.94 },
      { inset: Math.round(2 * scale), color: paper, alpha: 0.8 },
      { inset: Math.round(4 * scale), color: accent, alpha: 0.32 },
      { inset: Math.round(6 * scale), color: accent, alpha: 0.16 },
    ];
    const shadeOf = new Uint8Array(order.length);
    const draw = (progress: number) => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < order.length; i++) shadeOf[i] = revealShade(order[i], progress);
      shades.forEach(({ inset, color, alpha }, shade) => {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        const size = cell - inset * 2;
        for (let i = 0; i < order.length; i++) {
          if (shadeOf[i] === shade) ctx.fillRect((i % cols) * cell + inset, Math.floor(i / cols) * cell + inset, size, size);
        }
      });
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.14 * (1 - progress);
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    };
    // Cover in the same frame the new view mounts, so its first layout never shows.
    draw(0);
    canvas.style.visibility = 'visible';
    const start = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      const progress = Math.max(0, (now - start - REVEAL.holdMs) / REVEAL.dissolveMs);
      if (progress >= 1) { canvas.style.visibility = 'hidden'; return; }
      draw(progress);
      raf = requestAnimationFrame(frame);
    });
    return () => { cancelAnimationFrame(raf); canvas.style.visibility = 'hidden'; };
  }, [view]);
  return <canvas ref={ref} className="view-reveal" aria-hidden="true" />;
}
