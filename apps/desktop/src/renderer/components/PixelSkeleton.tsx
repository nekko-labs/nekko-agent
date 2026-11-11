import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { prefersReducedMotion } from '../displays.js';

/**
 * A loading placeholder in the same chunky ASCII-pixel language as the view
 * reveal: each 8px cell is one of four shades (█ ▓ ▒ ░), the fuller ones in
 * paper and the lighter ones tinted with the theme accent over a faint aura, all held
 * soft so the placeholder sits back rather than shouting.
 * On mount it dissolves in from clear in about 320ms, then stays still so a
 * wall of skeletons stays cheap. When the real content lands, the caller swaps
 * the skeleton for it.
 *
 * Takes its size from its container: size the wrapper with Tailwind classes or
 * a style, and the canvas fills it (devicePixelRatio and resizes handled).
 */
export const PIXEL_SKELETON = { cell: 8, revealMs: 320 } as const;

/** Stable pseudo-random noise per cell, so the pattern is the same between paints and across resizes. */
export function pixelSkeletonNoise(col: number, row: number): number {
  let h = (col * 374761393 + row * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Which of the four shades a cell shows at rest, from its noise value. Weighted toward the fuller shades so the pattern reads as a card, not thin dots. */
export function pixelSkeletonShade(noise: number): 0 | 1 | 2 | 3 {
  if (noise < 0.38) return 0;
  if (noise < 0.70) return 1;
  if (noise < 0.88) return 2;
  return 3;
}

export function PixelSkeleton({ className, style, label }: { className?: string; style?: CSSProperties; label?: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = host.current, cvs = canvas.current;
    if (!el || !cvs) return;
    let raf = 0;
    const paint = (progress: number) => {
      const scale = window.devicePixelRatio || 1;
      const width = el.clientWidth, height = el.clientHeight;
      if (!width || !height) return;
      cvs.width = Math.round(width * scale);
      cvs.height = Math.round(height * scale);
      const ctx = cvs.getContext('2d')!;
      const css = getComputedStyle(document.documentElement);
      const paper = css.getPropertyValue('--paper').trim() || '#0b0c14';
      const accent = css.getPropertyValue('--accent').trim() || '#8b7dff';
      const cell = Math.max(4, Math.round(PIXEL_SKELETON.cell * scale));
      const gap = cell / 8;
      const cols = Math.ceil(cvs.width / cell), rows = Math.ceil(cvs.height / cell);
      const shades = [
        { inset: 0, color: paper, alpha: 0.5 },
        { inset: Math.round(gap), color: paper, alpha: 0.38 },
        { inset: Math.round(gap * 2), color: accent, alpha: 0.16 },
        { inset: Math.round(gap * 3), color: accent, alpha: 0.09 },
      ];
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      // Faint accent aura, held behind the blocks so an idle skeleton still has depth.
      const aura = ctx.createRadialGradient(cvs.width / 2, cvs.height / 2, 0, cvs.width / 2, cvs.height / 2, Math.hypot(cvs.width, cvs.height) / 2);
      aura.addColorStop(0, accent);
      aura.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.06 * progress;
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      // Dissolve-in: a cell appears only once `progress` has reached its noise threshold.
      shades.forEach(({ inset, color, alpha }, shadeIdx) => {
        ctx.fillStyle = color;
        const size = cell - inset * 2;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const n = pixelSkeletonNoise(col, row);
            if (pixelSkeletonShade(n) !== shadeIdx) continue;
            const threshold = n * 0.9;
            if (progress < threshold) continue;
            const local = Math.min(1, (progress - threshold) / 0.1);
            ctx.globalAlpha = alpha * local;
            ctx.fillRect(col * cell + inset, row * cell + inset, size, size);
          }
        }
      });
      ctx.globalAlpha = 1;
    };
    if (prefersReducedMotion()) {
      paint(1);
    } else {
      const start = performance.now();
      raf = requestAnimationFrame(function frame(now) {
        const t = Math.min(1, (now - start) / PIXEL_SKELETON.revealMs);
        paint(t);
        if (t < 1) raf = requestAnimationFrame(frame);
      });
    }
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint(1));
    ro?.observe(el);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, []);
  return (
    <span ref={host} className={`pixel-skeleton ${className ?? ''}`} style={style} role="status" aria-label={label}>
      <canvas ref={canvas} aria-hidden="true" />
    </span>
  );
}
