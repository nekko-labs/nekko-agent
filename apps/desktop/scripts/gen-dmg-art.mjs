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
text('DRAG THE CAT INTO APPLICATIONS', W / 2, 22, 2, CREAM);
text("THEN OPEN IT FROM APPLICATIONS. THAT'S IT.", W / 2, 46, 1, SAGE, 1);

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
  if (t > 0.3 && t < 0.72) continue; // the cat is here
  rect(Math.round(x / 2) * 2 - 2, Math.round(arcY(x) / 2) * 2 - 2, 4, 4, SAGE);
}
sprite(['#######', '.#####.', '..###..', '...#...'], arcEnd - 7, arcBase - 2, 2, { '#': SAGE });

// The leaping cat, side view facing right, at the apex. c = cream,
// e = dark eye, n = sage nose, s = sage stripes.
const CAT = [
  '......................c...c.',
  '......................cc.cc.',
  '..ccc................cccccc.',
  '.c..................ccccecc.',
  '.c..................cccccccn',
  '..c.......cccccccccccccccc..',
  '...cccccccccccccccccccccc...',
  '....cccccsscccsscccccccc....',
  '.....cccccccccccccccccccc...',
  '....ccc..............ccccc..',
  '...ccc................cccc..',
  '..ccc..................cccc.',
  '.cc.....................ccc.',
];
const catPx = 4;
const catW = CAT[0].length * catPx;
const catX = W / 2 - catW / 2;
const catY = apex - 30;
sprite(CAT, catX, catY, catPx, { c: CREAM, e: DARK, n: SAGE, s: SAGE });

// Motion streaks behind the cat.
rect(catX - 28, catY + 18, 16, 2, SAGE);
rect(catX - 38, catY + 26, 22, 2, SAGE);
rect(catX - 26, catY + 34, 12, 2, SAGE);

await img.write(resolve(build, 'background@2x.png'));
const one = img.clone().resize({ w: W, h: H, mode: 'nearestNeighbor' });
await one.write(resolve(build, 'background.png'));
console.log(`wrote background.png (${W}x${H}) + background@2x.png`);
