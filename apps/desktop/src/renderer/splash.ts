/**
 * The startup splash: the logo builds up from pixels ("Res-up"), then zooms
 * towards the viewer while the inside of the cat opens as a window onto the
 * app behind it, until the app fills the screen.
 *
 * It runs before React mounts, so it can't wait for settings. Instead
 * `rememberSplashColours` stores the theme's colours each time the theme is
 * applied, and the next launch reads them straight from storage.
 *
 * Everything is drawn in one full-window SVG on a 120 BPM beat (B = 500ms),
 * animating only transform and opacity.
 */
import { BRAND_HEAD } from './components/BrandMark.js';
import { CHUNKY_CELLS, CHUNKY_SIZE, FINE_PATH, MID_PATH } from './splashCells.js';

const KEY = 'nekko.splash';
const B = 500;
const OUT = 'cubic-bezier(.2,.8,.2,1)';
const NS = 'http://www.w3.org/2000/svg';
/** The website's own pairing, for a first launch with nothing stored yet. */
const DEFAULT = { bg: '#9d8ce6', fg: '#ffffff' };

type Colours = { bg: string; fg: string };

/**
 * Store the current theme's splash colours. The ground is always a solid colour
 * from the theme, never a pale one, so the splash can't flash white: the first
 * of `candidates` that is dark enough, else the website's lavender.
 */
export function rememberSplashColours(candidates: (string | undefined)[]): void {
  try {
    // With no preset colours, the theme's accent as the stylesheet resolves it.
    if (!candidates.some(Boolean)) candidates = [getComputedStyle(document.documentElement).getPropertyValue('--accent')];
    const bg = candidates.map((c) => (c ? toHex(c) : null)).find((c): c is string => !!c && luminance(c) < 0.6) ?? DEFAULT.bg;
    localStorage.setItem(KEY, JSON.stringify({ bg, fg: readableOn(bg) }));
  } catch {
    /* storage blocked: the default colours are used */
  }
}

/** Any CSS colour as #rrggbb, or null. */
function toHex(c: string): string | null {
  const v = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000001';
  ctx.fillStyle = v;
  const out = String(ctx.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(out) && out !== '#000001' ? out : null;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function storedColours(): Colours {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Colours> | null;
    if (v && typeof v.bg === 'string' && typeof v.fg === 'string') return { bg: v.bg, fg: v.fg };
  } catch {
    /* fall through */
  }
  return DEFAULT;
}

/** White or ink, whichever contrasts more with `hex`. */
function readableOn(hex: string): string {
  const l = luminance(hex);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0584 ? '#ffffff' : '#17151f';
}

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  parent?.appendChild(n);
  return n;
};

/** Pivot an element's transforms around (x, y) in its SVG user space. */
const pivot = <T extends SVGElement>(n: T, x: number, y: number): T => {
  n.style.transformBox = 'view-box';
  n.style.transformOrigin = `${x}px ${y}px`;
  return n;
};

/**
 * Show the splash over the app and play it. `ready` resolves when the app
 * behind is worth revealing; the zoom waits for it (up to a cap) so the window
 * never opens onto a loading screen.
 */
export function playSplash(ready: Promise<unknown>): void {
  const { bg, fg } = storedColours();
  const W = window.innerWidth, H = window.innerHeight;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  document.body.appendChild(host);
  const remove = () => host.remove();

  const svg = el('svg', { width: '100%', height: '100%', viewBox: `0 0 ${W} ${H}` }, host);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    svg.appendChild(el('rect', { width: W, height: H, fill: bg }));
    void ready.then(() => host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).finished).finally(remove);
    return;
  }

  // Logo units: the mark spans roughly x 2..22. Keep it small and central, a little under a tenth of the window.
  const k = Math.max(40, Math.max(W, H) * 0.085) / 20;
  const ox = W / 2 - 12 * k, oy = H / 2 - 9 * k;
  const place = `translate(${ox} ${oy}) scale(${k})`;
  const INNER = BRAND_HEAD.slice(BRAND_HEAD.indexOf('ZM') + 1); // the window inside the cat

  const defs = el('defs', {}, svg);
  const mask = el('mask', { id: 'nekko-splash-mask', maskUnits: 'userSpaceOnUse', x: -W, y: -H, width: 3 * W, height: 3 * H }, defs);
  el('rect', { x: -W, y: -H, width: 3 * W, height: 3 * H, fill: '#fff' }, mask);
  const zoomMask = el('g', {}, mask);
  el('path', { d: INNER, fill: '#000', transform: place }, zoomMask);
  el('rect', { x: -W, y: -H, width: 3 * W, height: 3 * H, fill: bg, mask: 'url(#nekko-splash-mask)' }, svg);

  const zoomLogo = el('g', {}, svg);
  const logo = el('g', { transform: place }, zoomLogo);
  // Keeps the window shut until the zoom. The stroke overlaps the window's anti-aliased edge,
  // which otherwise lets the app show through as a faint outline of the cat.
  const lid = el('path', { d: INNER, fill: bg, stroke: bg, 'stroke-width': 0.2 }, logo);
  const g = pivot(el('g', {}, logo), 12, 9);

  // The build is set up paused and starts once the window is really on screen;
  // a window is often shown a moment after the page has loaded.
  const timeline: Animation[] = [];
  const hold = (a: Animation) => { a.pause(); timeline.push(a); };
  // Only an element's first animation holds its starting frame before it begins. A later
  // one holding its own start would override the earlier ones from the very first frame
  // (the medium and fine layers would show at once, stacked over the chunky build).
  const started = new Set<Element>();
  const fill = (n: Element): FillMode => (started.has(n) ? 'forwards' : (started.add(n), 'both'));
  const at = (n: Element, frames: Keyframe[], delay: number, duration: number, easing = OUT) =>
    hold(n.animate(frames, { delay, duration, easing, fill: fill(n) }));
  const swap = (n: Element, on: boolean, t: number) =>
    hold(n.animate([{ opacity: on ? 0 : 1 }, { opacity: on ? 1 : 0 }], { delay: t, duration: 1, fill: fill(n) }));

  // Beat 1: chunky pixels pop in left to right. Beats 2 and 2½: medium, fine. Beat 3: the smooth mark.
  // The pixel layers are worked out ahead of time (splashCells.ts), so nothing is rasterised at launch.
  const s1 = CHUNKY_SIZE;
  const big = el('g', {}, g);
  for (const [x, y] of CHUNKY_CELLS) {
    const r = pivot(el('rect', { x: x + 0.07, y: y + 0.07, width: s1 - 0.14, height: s1 - 0.14, fill: fg, 'shape-rendering': 'crispEdges' }, big), x + s1 / 2, y + s1 / 2);
    at(r, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], ((x - 2) / 19) * 0.6 * B, 0.3 * B);
  }
  const mid = el('path', { d: MID_PATH, fill: fg }, g);
  const fine = el('path', { d: FINE_PATH, fill: fg }, g);
  const vec = el('path', { d: BRAND_HEAD, fill: fg, stroke: fg, 'stroke-width': 0.5, 'stroke-linejoin': 'miter', 'stroke-miterlimit': 8, 'fill-rule': 'evenodd' }, g);
  swap(big, false, B); swap(mid, true, B);
  swap(mid, false, 1.5 * B); swap(fine, true, 1.5 * B);
  swap(fine, false, 2 * B); swap(vec, true, 2 * B);
  for (const t of [B, 1.5 * B, 2 * B]) at(g, [{ transform: 'scale(.988)' }, { transform: 'scale(1)' }], t, 0.22 * B);

  // The zoom: a small wind-up while the window clears, then steady exponential growth through the cat.
  const cx = ox + 12 * k, cy = oy + 10.6 * k;
  const reach = (Math.hypot(W, H) / (8 * k)) * 1.6; // big enough that the window covers the screen
  const frames: Keyframe[] = [{ transform: 'scale(1)', offset: 0, easing: 'cubic-bezier(.3,0,.5,1)' }, { transform: 'scale(.93)', offset: 0.25 }];
  for (let i = 1; i <= 14; i++) {
    const u = i / 14;
    frames.push({ transform: `scale(${(0.93 * Math.pow(reach / 0.93, Math.pow(u, 1.35))).toFixed(4)})`, offset: 0.25 + 0.75 * u });
  }
  const D = 1.05 * B;
  const zoom = () => {
    for (const z of [zoomMask, zoomLogo]) pivot(z, cx, cy).animate(frames, { duration: D, easing: 'linear', fill: 'forwards' });
    lid.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 0.05 * D, duration: 0.35 * D, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
    setTimeout(remove, D + 50);
  };
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const onScreen = new Promise<void>((resolve) => {
    if (document.visibilityState === 'visible') return resolve();
    const seen = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', seen); resolve(); } };
    document.addEventListener('visibilitychange', seen);
  }).then(frame).then(frame);
  // The app's first render is heavy; zooming during it drops most of the zoom's frames.
  const idle = () => new Promise<void>((r) => (window.requestIdleCallback ? window.requestIdleCallback(() => r(), { timeout: 700 }) : setTimeout(r, 200)));
  const capped = Promise.race([ready.then(idle), new Promise((r) => setTimeout(r, 6000))]);
  void onScreen.then(() => {
    for (const a of timeline) a.play();
    const built = new Promise((r) => setTimeout(r, 2.5 * B));
    return Promise.all([built, capped]);
  }).then(zoom, zoom);
}
