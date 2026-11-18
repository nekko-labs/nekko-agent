// The site's backdrop, shared by the home page and the changelog: each page
// supplies a <canvas id="pixelwave"> and loads this file.
// ---- dot-matrix swell background: a fine grid of pixel dots that mostly
//      sits invisible, with a soft wave of brightness drifting through it.
//      The grid is fixed to the screen and ignores scrolling, so the wave
//      keeps one steady pace however the page moves. Brand gradient (plum to
//      light plum, left to right) on the white version,
//      and light plum to rose on the dark one. ~20 fps, pauses when the tab is hidden, and holds still for
//      reduced-motion visitors. ----
(() => {
  const c = document.getElementById('pixelwave');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CELL = 9; // small dots, high density
  let W = 0, H = 0, dpr = 1, t = 0, last = 0, raf = 0;
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  };
  const look = () => document.documentElement.dataset.theme;
  const draw = () => {
    const theme = look();
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y += CELL) {
      for (let x = 0; x < W; x += CELL) {
        const w = Math.sin(x / 110 - t * 1.4 + Math.sin(y / 150 + t * 0.5) * 1.6);
        const a = Math.max(0, w) ** 3 * 0.34;
        if (a < 0.025) continue;
        const s = a > 0.18 ? 3 : 2;
        const k = x / W;
        if (theme === 'dark') {
          // 0 = light plum #c084b5, 1 = rose #854f6c: glowing on the dark ground
          ctx.fillStyle = `rgba(${Math.round(192 - 59 * k)},${Math.round(132 - 53 * k)},${Math.round(181 - 73 * k)},${(a * 1.1).toFixed(3)})`;
        } else {
          // 0 = plum #5a2352, 1 = light plum #c084b5
          ctx.fillStyle = `rgba(${Math.round(90 + 102 * k)},${Math.round(35 + 97 * k)},${Math.round(82 + 99 * k)},${a.toFixed(3)})`;
        }
        ctx.fillRect(Math.round(x + (CELL - s) / 2), Math.round(y + (CELL - s) / 2), s, s);
      }
    }
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 50) return;
    t += (now - last) / 1000 * 0.72; // 20% slower than the original 0.9
    last = now;
    draw();
  };
  // The wave keeps moving down the whole page; the panels over it are solid,
  // so redrawing behind them stays cheap. Only a hidden tab stops it.
  const start = () => { if (!raf && !reduced && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  size(); draw();
  // A phone's URL bar showing or hiding fires resize with only the height
  // changed a little: keep the canvas rather than reallocating it.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth === W && Math.abs(window.innerHeight - H) < 120) return;
      size(); draw();
    }, 150);
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  start();
})();
