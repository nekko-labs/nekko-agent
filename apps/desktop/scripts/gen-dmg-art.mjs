// Generates the macOS drag-to-install window background: a pixel Nekko leaping
// from the app icon over to the Applications folder.
// Run: node apps/desktop/scripts/gen-dmg-art.mjs
//
// Writes build/background.png (640x400) and build/background@2x.png. dmg-builder
// merges the pair into a HiDPI .tiff itself (tiffutil -cathidpicheck), and the
// 1x size sets the Finder window size. The icon positions in the `dmg` section
// of electron-builder.yml must match ICON_Y / APP_X / APPS_X below.
//
// Everything is drawn on a 2px grid at 1x (4px at 2x) so the art stays crisp
// pixel art at both scales; there are no fonts, the lettering is a 5x7 bitmap.
import { Jimp, rgbaToInt } from 'jimp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const build = resolve(__dirname, '../build');

export const W = 640;
export const H = 400;
export const ICON_Y = 200;
export const APP_X = 160;
export const APPS_X = 480;

const S = 2; // drawn at 2x, downscaled with nearest neighbour for 1x
const rgb = (hex) => rgbaToInt((hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255);
const BG_TOP = 0x161d19;
const BG_BOTTOM = 0x0f1311;
const GRID = rgb(0x1a221d);
const CREAM = rgb(0xf2efe6);
const SAGE = rgb(0xa7c8ac);
const DARK = rgb(0x121714);
// Finder draws the icon labels in black over the background, dark mode
// included (checked on macOS 27), so the labels sit on light sage ledges.
const LEDGE = rgb(0x9dbfa3);
const LEDGE_EDGE = rgb(0xc4dcc8);
const LEDGE_SHADOW = rgb(0x5f7c66);

const img = new Jimp({ width: W * S, height: H * S, color: rgb(BG_TOP) });

// Rect in 1x coordinates.
const rect = (x, y, w, h, c) => {
  for (let yy = Math.round(y * S); yy < Math.round((y + h) * S); yy++)
    for (let xx = Math.round(x * S); xx < Math.round((x + w) * S); xx++)
      if (xx >= 0 && yy >= 0 && xx < W * S && yy < H * S) img.setPixelColor(c, xx, yy);
};

// Background: vertical gradient plus the faint grid from the brand banner.
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const mix = (a, b, sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  const c = rgbaToInt(mix(BG_TOP, BG_BOTTOM, 16), mix(BG_TOP, BG_BOTTOM, 8), mix(BG_TOP, BG_BOTTOM, 0), 255);
  rect(0, y, W, 1, c);
}
for (let x = 0; x < W; x += 32) rect(x, 0, 1, H, GRID);
for (let y = 8; y < H; y += 32) rect(0, y, W, 1, GRID);

// Bitmap sprite: each character is one block of `px` 1x pixels.
const sprite = (rows, x, y, px, palette) => {
  rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const col = palette[ch];
      if (col !== undefined) rect(x + c * px, y + r * px, px, px, col);
    }),
  );
};

// 5x7 caps font, just the glyphs the copy needs.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  ',': ['.', '.', '.', '.', '.', '#', '#'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
};
const textWidth = (s, px, gap) =>
  [...s].reduce((w, ch) => w + (FONT[ch][0].length + gap) * px, 0) - gap * px;
const text = (s, cx, y, px, color, gap = 1) => {
  let x = cx - textWidth(s, px, gap) / 2;
  for (const ch of s) {
    sprite(FONT[ch], x, y, px, { '#': color });
    x += (FONT[ch][0].length + gap) * px;
  }
};

// Copy.
// Copy goes at the top: a user whose Finder shows the path and status bars
// loses the bottom ~50px of the window to them.
text('DRAG THE CAT INTO APPLICATIONS', W / 2, 16, 2, CREAM);
text("THEN OPEN IT FROM APPLICATIONS. THAT'S IT.", W / 2, 38, 1, SAGE, 1);

// Ledges the two icons stand on, with the gap between them for the leap.
const ledge = (cx) => {
  const w = 196;
  const x = cx - w / 2;
  const y = 258;
  rect(x, y, w, 2, LEDGE_EDGE);
  rect(x, y + 2, w, 24, LEDGE);
  // stepped pixel underside
  rect(x + 6, y + 26, w - 12, 4, LEDGE_SHADOW);
  rect(x + 16, y + 30, w - 32, 4, LEDGE_SHADOW);
  rect(x + 32, y + 34, w - 64, 4, LEDGE_SHADOW);
};
ledge(APP_X);
ledge(APPS_X);

// Dotted leap arc from above the app icon to above the Applications folder:
// a parabola with its apex under the cat, ending in an arrowhead.
const arcStart = APP_X + 24;
const arcEnd = APPS_X - 24;
const arcBase = ICON_Y - 58;
const apex = 100;
const arcY = (x) => {
  const t = (x - arcStart) / (arcEnd - arcStart);
  return arcBase - (arcBase - apex) * 4 * t * (1 - t);
};
for (let x = arcStart; x <= arcEnd - 10; x += 14) {
  const t = (x - arcStart) / (arcEnd - arcStart);
  if (t > 0.18 && t < 0.84) continue; // the cat is here
  rect(Math.round(x / 2) * 2 - 2, Math.round(arcY(x) / 2) * 2 - 2, 4, 4, SAGE);
}
sprite(['#######', '.#####.', '..###..', '...#...'], arcEnd - 7, arcBase - 2, 2, { '#': SAGE });

// The leaping cat, in the brand style: the app's own pixel head (the path in
// renderer/components/Mascot.tsx, on its 32-unit grid) on a black leaping body,
// all filled #101714 with the same 2-unit cream outline centred on the edge,
// cream 2x3 eyes and the sage mouth. Built as a mask so head, body, legs and
// tail share one continuous outline.
const INK = rgb(0x101714);
const HEAD = [[4, 5], [6, 5], [6, 7], [8, 7], [8, 9], [11, 9], [11, 10], [21, 10], [21, 9], [24, 9], [24, 7], [26, 7], [26, 5], [28, 5], [28, 19], [27, 19], [27, 22], [25, 22], [25, 24], [22, 24], [22, 26], [10, 26], [10, 24], [7, 24], [7, 22], [5, 22], [5, 19], [4, 19]];
const inPoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const GW = 92;
const GH = 44;
const OY = 0;
const HX = 52; // head offset on the cat grid
const HY = 0;
const mask = Array.from({ length: GH }, () => new Array(GW).fill(false));
const paint = (test) => {
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (test(x + 0.5, y + 0.5 - OY)) mask[y][x] = true;
};
// A leg or the tail: a stroke along a quadratic curve from a to b via c,
// thick where it joins the body (r) and tapering to r2.
const limb = (a, c, b, r, r2 = r) => {
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const m = 1 - t;
    pts.push([m * m * a[0] + 2 * m * t * c[0] + t * t * b[0], m * m * a[1] + 2 * m * t * c[1] + t * t * b[1], r + (r2 - r) * t]);
  }
  paint((x, y) => pts.some(([px, py, pr]) => (x - px) ** 2 + (y - py) ** 2 <= pr * pr));
};
// A paw: a flat oval at the end of a leg, so it reads as a foot.
const paw = (cx, cy, rx = 3, ry = 2.2) => paint((x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);
// Full stretch of a leap: back arched with the hips higher than the
// shoulders, both front legs reaching ahead under the chin, both back legs
// pushed out behind, tail streaming back off the hips.
paint((x, y) => inPoly(HEAD, x - HX, y - HY));
// Body: shoulders under the head (filling the step under the jaw), rising
// to high hips.
paint((x, y) => inPoly([[58, 16], [46, 13], [34, 11], [26, 12], [21, 16], [21, 22], [26, 26], [36, 29], [48, 30], [58, 29], [63, 27], [63, 22]], x, y));
// Front legs reach out past the chin, tapered so they read as legs rather
// than ribbons: the far one higher, the near one lower.
limb([57, 27], [70, 31], [82, 30], 3.4, 2);
paw(84, 30);
limb([51, 29], [64, 37], [77, 38], 3.4, 2);
paw(79, 38);
// Back legs push out behind: far one higher, near one lower.
limb([25, 19], [19, 21], [13, 21], 3.4, 2);
paw(12, 21);
limb([30, 25], [24, 31], [17, 32], 3.4, 2);
paw(16, 32);
// Tail: back and only a little up off the hips, curling up at the tip, so
// it stays clear of the copy above.
limb([22, 14], [12, 13], [6, 8], 2.4, 1.8);
limb([6, 8], [4, 4], [8, 3], 1.8, 1.6);
const at = (x, y) => y >= 0 && y < GH && x >= 0 && x < GW && mask[y][x];
const nearEdge = (x, y, want) => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(x + dx, y + dy) === want) return true;
  return false;
};
const u = 2; // 1x pixels per grid unit
const catW = GW * u;
const catX = Math.round((W / 2 - catW / 2) / 2) * 2;
const catY = apex - 42;
for (let y = 0; y < GH; y++)
  for (let x = 0; x < GW; x++) {
    let c;
    if (at(x, y)) c = nearEdge(x, y, false) ? CREAM : INK; // inner half of the outline
    else if (nearEdge(x, y, true)) c = CREAM; // outer half
    if (c !== undefined) rect(catX + x * u, catY + y * u, u, u, c);
  }
// Face, on the head's own grid.
const face = (x, y, w, h, c) => rect(catX + (HX + x) * u, catY + (HY + OY + y) * u, w * u, h * u, c);
face(11, 15, 2, 3, CREAM);
face(20, 15, 2, 3, CREAM);
face(15, 20, 2, 1, SAGE);

// Motion streaks behind the cat.
rect(catX - 2, catY + 26, 12, 2, SAGE);
rect(catX - 12, catY + 32, 20, 2, SAGE);

await img.write(resolve(build, 'background@2x.png'));
const one = img.clone().resize({ w: W, h: H, mode: 'nearestNeighbor' });
await one.write(resolve(build, 'background.png'));
console.log(`wrote background.png (${W}x${H}) + background@2x.png`);
