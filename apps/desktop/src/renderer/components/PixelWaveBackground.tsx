import React, { useEffect, useRef } from 'react';

/**
 * The marketing site's dot-matrix swell (nekkoagent.com), for the Lilac and
 * Lavender presets: a fine grid of pixel dots that mostly sits invisible, with
 * a soft wave of brightness drifting through it. Lilac draws the logo's
 * indigo-to-lavender gradient left to right; Lavender, whose ground is already
 * that lavender, draws white dots. Decorative only: it never takes input,
 * runs at ~15 fps, stops while the window is hidden, and holds one still frame
 * for reduced motion.
 */
export function PixelWaveBackground({ variant }: { variant: 'lilac' | 'lavender' }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 9;
    // Behind the panels the dots only show in the field around them, so they can be as strong as on the website.
    const peak = variant === 'lavender' ? 0.34 : 0.26;
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
          if (variant === 'lavender') ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          else {
            const k = x / Math.max(w, 1); // 0 = indigo #453A92, 1 = lavender #9D8CE6
            ctx.fillStyle = `rgba(${Math.round(69 + 88 * k)},${Math.round(58 + 82 * k)},${Math.round(146 + 84 * k)},${a.toFixed(3)})`;
          }
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
  }, [variant]);

  return <canvas ref={ref} className="pixel-wave-background" aria-hidden="true" />;
}
