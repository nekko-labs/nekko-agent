// The brand pack at nekkoagent.com/brand: the files people may use to write
// about Nekko Agent (docs/hub/brand.md says how, TRADEMARKS.md says on what
// terms). Everything is drawn from the same sources the app and site use, so
// the pack cannot drift from the product:
//
//   the cat mark and app icon   apps/desktop/scripts/icon-art.cjs
//   Nekko, the mascot           the pixel head in apps/website/index.html,
//                               coloured by spec/brand/colour-palette.md
//   the NEKKO AGENT wordmark    Inter Tight 800, outlined once into
//                               scripts/brand-kit/wordmark.json
//
//   node scripts/make-brand-kit.mjs             write the SVGs and PNGs
//   node scripts/make-brand-kit.mjs --check     exit 1 if a committed SVG is stale
//   node scripts/make-brand-kit.mjs --wordmark  re-outline the wordmark first
//                                               (needs `npm i --no-save fontkit@2.0.4 wawoff2@2.0.1`)
//
// PNGs are drawn by rsvg-convert (librsvg: `brew install librsvg` or
// `apt install librsvg2-bin`), a build tool only; nothing of it ships.
//
// The zip of the whole pack is not committed: scripts/build-docs.mjs calls
// writeBrandZip() on deploy, so the zip and the files beside it cannot disagree.
import { execFileSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const art = require('../apps/desktop/scripts/icon-art.cjs');

export const BRAND_DIR = join(repo, 'apps', 'website', 'brand');
export const ZIP_NAME = 'nekko-agent-brand-pack.zip';
const WORDMARK = join(repo, 'scripts', 'brand-kit', 'wordmark.json');
const FONT = join(repo, 'apps', 'website', 'fonts', 'inter-tight-latin-wght-normal.woff2');

/* ── colours (spec/brand/colour-palette.md) ───────────────────────────────── */

export const COLOURS = {
  plum: '#190019',
  secondary: '#854F6C',
  white: '#FFFFFF',
  black: '#000000',
  markFrom: '#5A2352',
  markTo: '#C084B5',
  // Nekko on a dark ground, and on a light one. Never mixed.
  nekkoDark: { face: '#16161C', line: '#F3E8EE', eyes: '#FFFFFF', mouth: '#854F6C' },
  nekkoLight: { face: '#FFFFFF', line: '#190019', eyes: '#190019', mouth: '#854F6C' },
};

/* ── geometry ─────────────────────────────────────────────────────────────── */

// The mark's ink on its 24-unit grid, padded for the 0.5 thickening stroke the
// site's logo.svg also carries. Same numbers as icon-art.cjs logoSvg().
const PAD = 0.6;
const MARK_BOX = { x: art.ART.x - PAD, y: art.ART.y - PAD, w: art.ART.w + PAD * 2, h: art.ART.h + PAD * 2 };

// Nekko's pixel head on a 32 grid: the website's beta-card and banner geometry.
const NEKKO = {
  head: 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z',
  eyes: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  mouth: 'M15 20H17V21H15Z',
};

const n = (v) => +v.toFixed(3);
const svgOpen = (vb, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(n).join(' ')}"${extra}>`;
const gradientDef = (id, x1, x2) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(x1)}" y1="0" x2="${n(x2)}" y2="0"><stop offset="0" stop-color="${COLOURS.markFrom}"/><stop offset="1" stop-color="${COLOURS.markTo}"/></linearGradient>`;

/** The cat mark's path, filled and thickened in one paint (a colour or url(#id)). */
const markPath = (paint) =>
  `<path d="${art.HEAD}" fill="${paint}" fill-rule="evenodd" stroke="${paint}" stroke-width="0.5" stroke-linejoin="miter" stroke-miterlimit="8"/>`;

/** The mark alone. `colour` is a hex, or 'gradient' for the site's plum gradient. */
export function markSvg(colour) {
  const b = MARK_BOX;
  const paint = colour === 'gradient' ? 'url(#mark)' : colour;
  const defs = colour === 'gradient' ? `<defs>${gradientDef('mark', art.ART.x, art.ART.x + art.ART.w)}</defs>` : '';
  return `${svgOpen([b.x, b.y, b.w, b.h])}${defs}${markPath(paint)}</svg>\n`;
}

/** Nekko's pixel head. `look` is 'dark' (for dark grounds) or 'light' (for light grounds). */
export function nekkoSvg(look) {
  const c = look === 'dark' ? COLOURS.nekkoDark : COLOURS.nekkoLight;
  return `${svgOpen([0, 0, 32, 32], ' shape-rendering="crispEdges"')}
  <path d="${NEKKO.head}" fill="${c.face}" stroke="${c.line}" stroke-width="2" stroke-linejoin="miter"/>
  <path d="${NEKKO.eyes}" fill="${c.eyes}"/>
  <path d="${NEKKO.mouth}" fill="${c.mouth}"/>
</svg>\n`;
}

/** The app icon: white cat on the plum squircle, drawn at full detail. */
export function appIconSvg() {
  return art.iconSvg(512).replace(/ width="\d+" height="\d+"/, '') + '\n';
}

/**
 * The website nav's lockup, NEKKO AGENT beside the mark, as one drawing:
 * Inter Tight 800 with 0.14em tracking (apps/website/styles.css `.brand`), the
 * mark about twice the cap height and centred on the caps, 0.55em between them.
 * Laid out in the wordmark's font units; the viewBox hugs the ink plus `pad`.
 */
export function lockupSvg(wordmark, { mark, text }) {
  const { capHeight, unitsPerEm, width, d } = wordmark;
  const markH = capHeight * 2.05;
  const s = markH / MARK_BOX.h;
  const markW = MARK_BOX.w * s;
  const gap = unitsPerEm * 0.55;
  const top = -(capHeight + markH) / 2; // mark centred on the caps (baseline is y 0)
  const pad = capHeight * 0.25;
  const w = markW + gap + width;
  const paint = mark === 'gradient' ? 'url(#mark)' : mark;
  const defs = mark === 'gradient' ? `<defs>${gradientDef('mark', art.ART.x, art.ART.x + art.ART.w)}</defs>` : '';
  return `${svgOpen([-pad, top - pad, w + pad * 2, markH + pad * 2])}${defs}
  <g transform="translate(${n(-MARK_BOX.x * s)} ${n(top - MARK_BOX.y * s)}) scale(${n(s)})">${markPath(paint)}</g>
  <path transform="translate(${n(markW + gap)} 0)" d="${d}" fill="${text}"/>
</svg>\n`;
}

/* ── the pack ─────────────────────────────────────────────────────────────── */

// Every file in the pack, with what it is for. The docs page, the zip and the
// test all read this list. `png` is the width to draw at (height follows).
export function brandFiles(wordmark = loadWordmark()) {
  return [
    { name: 'nekko-agent-mark.svg', png: 1024, svg: () => markSvg('gradient'), use: 'The cat mark in the plum gradient, for light grounds. The everyday choice.' },
    { name: 'nekko-agent-mark-plum.svg', png: 1024, svg: () => markSvg(COLOURS.plum), use: 'One colour, plum, for light grounds and one-colour print.' },
    { name: 'nekko-agent-mark-white.svg', png: 1024, svg: () => markSvg(COLOURS.white), use: 'White, for dark grounds and photos.' },
    { name: 'nekko-agent-mark-black.svg', png: 1024, svg: () => markSvg(COLOURS.black), use: 'Black, where only black is possible (fax, newsprint, engraving).' },
    { name: 'nekko-agent-lockup.svg', png: 2400, svg: () => lockupSvg(wordmark, { mark: 'gradient', text: COLOURS.plum }), use: 'Mark and NEKKO AGENT, for light grounds.' },
    { name: 'nekko-agent-lockup-white.svg', png: 2400, svg: () => lockupSvg(wordmark, { mark: COLOURS.white, text: COLOURS.white }), use: 'Mark and NEKKO AGENT in white, for dark grounds.' },
    { name: 'nekko-agent-lockup-black.svg', png: 2400, svg: () => lockupSvg(wordmark, { mark: COLOURS.black, text: COLOURS.black }), use: 'Mark and NEKKO AGENT in black, one colour.' },
    { name: 'nekko-agent-app-icon.svg', png: 1024, svg: appIconSvg, use: 'The app icon, as it looks on a dock or home screen. Use it to show the app itself (download links, app lists).' },
    { name: 'nekko-dark.svg', png: 1024, svg: () => nekkoSvg('dark'), use: 'Nekko, the mascot, for dark grounds: black face, pale outline.' },
    { name: 'nekko-light.svg', png: 1024, svg: () => nekkoSvg('light'), use: 'Nekko for white and light grounds: white face, plum outline.' },
  ];
}

/* ── the docs page's pictures ─────────────────────────────────────────────── */

// The pack's files are mostly white-on-nothing or plum-on-nothing, which shows
// as blank on a docs page. These two sheets put them on the grounds they are
// made for (and on the ones they are not), for docs/hub/brand.md only.
const GROUND = { light: '#FFFFFF', paper: '#FBF6F9', dark: '#0B0C14', plum: '#190019' };

/** One file's drawing, fitted inside a box, its ids made unique to the sheet. */
function placed(svg, x, y, w, h, key) {
  const vb = svg.match(/viewBox="([^"]+)"/)[1];
  const inner = svg
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/id="([^"]+)"/g, `id="${key}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${key}-$1)`);
  const rendering = svg.includes('crispEdges') ? ' shape-rendering="crispEdges"' : '';
  return `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"${rendering}>${inner}</svg>`;
}

function sheet(tiles, cols, { tileW = 360, tileH = 240, gap = 16, inset = 56 } = {}) {
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * tileW + (cols + 1) * gap;
  const H = rows * tileH + (rows + 1) * gap;
  const body = tiles.map((t, i) => {
    const x = gap + (i % cols) * (tileW + gap);
    const y = gap + Math.floor(i / cols) * (tileH + gap);
    const pad = t.inset ?? inset;
    const art = placed(t.svg, x + pad, y + pad, tileW - pad * 2, tileH - pad * 2, `t${i}`);
    const wrap = t.transform ? `<g transform="${t.transform(x + tileW / 2, y + tileH / 2)}">${art}</g>` : art;
    const cross = t.wrong
      ? `<g transform="translate(${x + tileW - 30} ${y + 30})"><circle r="15" fill="#C62828"/><path d="M-6 -6L6 6M6 -6L-6 6" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/></g>`
      : '';
    return `<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="16" fill="${t.ground}"${t.ground === GROUND.light ? ' stroke="#E3D3DF"' : ''}/>${wrap}${cross}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#F2E7EF"/>${body.join('')}</svg>\n`;
}

/** What is in the pack, each on the ground it is for. Read left to right, top to bottom. */
export function overviewSvg(wordmark = loadWordmark()) {
  return sheet([
    { svg: lockupSvg(wordmark, { mark: 'gradient', text: COLOURS.plum }), ground: GROUND.light, inset: 40 },
    { svg: markSvg('gradient'), ground: GROUND.light },
    { svg: nekkoSvg('light'), ground: GROUND.paper, inset: 40 },
    { svg: appIconSvg(), ground: GROUND.light, inset: 44 },
    { svg: lockupSvg(wordmark, { mark: COLOURS.white, text: COLOURS.white }), ground: GROUND.dark, inset: 40 },
    { svg: markSvg(COLOURS.white), ground: GROUND.dark },
    { svg: nekkoSvg('dark'), ground: GROUND.dark, inset: 40 },
    { svg: markSvg(COLOURS.plum), ground: GROUND.paper },
  ], 4);
}

/** Six ways not to use it, each marked with a red cross. Read left to right, top to bottom. */
export function misuseSvg(wordmark = loadWordmark()) {
  const purpleNekko = nekkoSvg('dark').replace(COLOURS.nekkoDark.face, '#6B4D99');
  return sheet([
    { svg: markSvg('#2E9E5B'), ground: GROUND.light, wrong: true },
    { svg: markSvg('gradient'), ground: GROUND.light, wrong: true, transform: (cx, cy) => `translate(${cx} ${cy}) scale(1.45 0.8) translate(${-cx} ${-cy})` },
    { svg: markSvg(COLOURS.white), ground: GROUND.dark, wrong: true, transform: (cx, cy) => `rotate(-18 ${cx} ${cy})` },
    { svg: nekkoSvg('light'), ground: GROUND.dark, wrong: true, inset: 40 },
    { svg: purpleNekko, ground: GROUND.dark, wrong: true, inset: 40 },
    { svg: lockupSvg(wordmark, { mark: 'gradient', text: COLOURS.plum }), ground: GROUND.plum, wrong: true, inset: 40 },
  ], 3);
}

export const PREVIEWS = [
  { name: 'brand-pack-overview', svg: overviewSvg, width: 1536 },
  { name: 'brand-pack-misuse', svg: misuseSvg, width: 1152 },
];
const PREVIEW_DIR = join(repo, 'docs', 'brand');

// Files that go in the zip beside the generated ones, from where they already live.
export const EXTRA_FILES = [
  { name: 'nekko-agent-banner-1280x640.png', from: join(repo, 'docs', 'brand', 'nekko-banner-1280x640.png'), use: 'The social banner (README and link previews).' },
  { name: 'LICENSE.md', from: join(BRAND_DIR, 'LICENSE.md'), use: 'The terms these files are licensed under.' },
];

export function loadWordmark() {
  return JSON.parse(readFileSync(WORDMARK, 'utf8'));
}

/** Outline NEKKO AGENT from Inter Tight at weight 800 into scripts/brand-kit/wordmark.json. */
async function outlineWordmark() {
  let fontkit, wawoff2;
  try {
    fontkit = (await import('fontkit')).default ?? (await import('fontkit'));
    wawoff2 = (await import('wawoff2')).default ?? (await import('wawoff2'));
  } catch {
    throw new Error('--wordmark needs fontkit and wawoff2: npm i --no-save fontkit@2.0.4 wawoff2@2.0.1');
  }
  // fontkit's weight instances of a WOFF2 come out without a cmap, so unpack the
  // site's WOFF2 to a plain TrueType font first and instance that.
  const ttf = Buffer.from(await wawoff2.decompress(readFileSync(FONT)));
  const font = fontkit.create(ttf).getVariation({ wght: 800 });
  const text = 'NEKKO AGENT';
  const tracking = 0.14;
  const run = font.layout(text);
  let x = 0;
  const parts = [];
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    const path = glyph.path.scale(1, -1).translate(x + pos.xOffset, -pos.yOffset);
    if (path.commands.length) parts.push(path.toSVG());
    x += pos.xAdvance;
    if (i < run.glyphs.length - 1) x += font.unitsPerEm * tracking;
  });
  // Round to whole font units: the outlines are integer in the font anyway.
  const d = parts.join('').replace(/-?\d*\.\d+/g, (v) => String(Math.round(Number(v))));
  const out = {
    $comment: 'NEKKO AGENT in Inter Tight 800 (OFL-1.1, apps/website/fonts/OFL-inter-tight.txt), 0.14em tracking, outlined by `node scripts/make-brand-kit.mjs --wordmark`. Font units, baseline at y 0, y down.',
    text,
    weight: 800,
    tracking,
    unitsPerEm: font.unitsPerEm,
    capHeight: font.capHeight,
    width: Math.round(x),
    d,
  };
  mkdirSync(dirname(WORDMARK), { recursive: true });
  writeFileSync(WORDMARK, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${WORDMARK}`);
}

function pngSize(svg, width) {
  const [, , w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  return { width, height: Math.round((width * h) / w) };
}

function writePack({ png = true } = {}) {
  mkdirSync(BRAND_DIR, { recursive: true });
  for (const f of brandFiles()) {
    const svg = f.svg();
    writeFileSync(join(BRAND_DIR, f.name), svg);
    if (!png) continue;
    const { width, height } = pngSize(svg, f.png);
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', join(BRAND_DIR, f.name.replace(/\.svg$/, '.png')), join(BRAND_DIR, f.name)]);
  }
  console.log(`wrote ${brandFiles().length} SVGs${png ? ' and PNGs' : ''} to apps/website/brand`);
  if (!png) return;
  // The docs page's two sheets: PNG only, the SVG is a scratch step.
  for (const p of PREVIEWS) {
    const svg = p.svg();
    const { width, height } = pngSize(svg, p.width);
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', join(PREVIEW_DIR, `${p.name}.png`)], { input: svg });
  }
  console.log('wrote docs/brand/brand-pack-overview.png and brand-pack-misuse.png');
}

function checkPack() {
  const stale = brandFiles().filter((f) => {
    const file = join(BRAND_DIR, f.name);
    return !existsSync(file) || readFileSync(file, 'utf8') !== f.svg() || !existsSync(file.replace(/\.svg$/, '.png'));
  });
  if (stale.length) {
    console.error(`stale brand pack files: ${stale.map((f) => f.name).join(', ')}\nrun: node scripts/make-brand-kit.mjs`);
    process.exitCode = 1;
  }
}

/* ── the zip ──────────────────────────────────────────────────────────────── */

// A plain zip (deflate, no extras) with a fixed date, so the same files always
// make the same bytes. Node has deflate and CRC-32; a zip is just their framing.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    head.copy(dir, 6, 4, 30); // the same fields as the local header
    dir.writeUInt32LE(offset, 42);
    centrals.push(dir, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function readme(files) {
  const lines = files.map((f) => `- ${f.name}: ${f.use}`);
  return `Nekko Agent brand pack
https://nekkoagent.com/docs/brand

Use these files to refer to Nekko Agent and Nekko Labs: in articles, reviews,
tutorials, videos, talks and community projects. Do not change them, and do
not use them to brand your own product. The full terms are in LICENSE.md and
at https://nekkoagent.com/docs/trademarks.

Each SVG has a PNG of the same name beside it.

${lines.join('\n')}

Questions or permission: hello@nekkoagent.com
`;
}

/**
 * Write apps/website/brand/<ZIP_NAME> and the banner copy the page links to.
 * Run on deploy by scripts/build-docs.mjs; both outputs are gitignored.
 * Returns the zip's entry names, for the test.
 */
export function writeBrandZip() {
  const files = brandFiles();
  const entries = [];
  for (const f of files) {
    entries.push({ name: `nekko-agent-brand-pack/${f.name}`, data: readFileSync(join(BRAND_DIR, f.name)) });
    const png = f.name.replace(/\.svg$/, '.png');
    entries.push({ name: `nekko-agent-brand-pack/${png}`, data: readFileSync(join(BRAND_DIR, png)) });
  }
  for (const f of EXTRA_FILES) entries.push({ name: `nekko-agent-brand-pack/${f.name}`, data: readFileSync(f.from) });
  entries.push({ name: 'nekko-agent-brand-pack/README.txt', data: Buffer.from(readme([...files, ...EXTRA_FILES])) });
  writeFileSync(join(BRAND_DIR, ZIP_NAME), zip(entries));
  const banner = EXTRA_FILES[0];
  writeFileSync(join(BRAND_DIR, banner.name), readFileSync(banner.from));
  return entries.map((e) => e.name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--wordmark')) await outlineWordmark();
  if (args.has('--check')) checkPack();
  else writePack({ png: !args.has('--svg-only') });
}
