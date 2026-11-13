/**
 * Draws the 1200x630 social preview cards for nekkoagent.com: the homepage card
 * (apps/website/og.png) and one card per page, so a shared link shows that
 * page's own title, always with the Nekko mark and the site's address on it.
 *
 *   node scripts/make-og-cards.mjs
 *   OG_BROWSER_CHANNEL=msedge node scripts/make-og-cards.mjs   (no Playwright Chromium)
 *
 * Writes apps/website/og/<name>.jpg: docs-<slug>.jpg for each docs page in
 * docs/hub/nav.json (docs-index.jpg for /docs), plus one per page in
 * STANDALONE. Colours and the cat come from the brand source
 * (apps/desktop/scripts/icon-art.cjs). Re-run after adding or renaming a page,
 * bump OG_VERSION in build-docs.mjs, then `npm run docs`.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadNav } from './build-docs.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(repo, 'apps', 'website');
const outDir = join(site, 'og');
const { HEAD, ART, TILE, TILE_END, INK } = createRequire(import.meta.url)('../apps/desktop/scripts/icon-art.cjs');

// Standalone pages: file name, eyebrow, title, one short line, path shown.
export const STANDALONE = [
  { name: 'beta', eyebrow: 'Beta', title: 'What beta means', line: 'What you get, what to expect, and what happens to your data.', path: '/beta' },
  { name: 'status', eyebrow: 'Status', title: 'Is Nekko working?', line: 'Live status for Nekko Cloud and phone access, plus known issues.', path: '/status' },
  { name: 'privacy', eyebrow: 'Privacy', title: 'Privacy policy', line: 'What we keep, why, who handles it, and your rights.', path: '/privacy' },
];

// Each docs section gets its own glow, all within the plum family, so a feed of
// Nekko links is easy to tell apart at a glance.
const HUES = { Introduction: '#c084b5', 'Using Nekko Agent': '#b0609f', Contributing: '#8f6bc4', 'For AI agents': '#d0789a' };
const PAGE_HUE = { beta: '#d0789a', status: '#7fa7c9', privacy: '#8f6bc4' };

export function cardsFor(pages) {
  return [
    ...pages.map((p) => ({
      name: `docs-${p.slug || 'index'}`,
      eyebrow: p.slug ? p.section : 'Docs',
      title: p.slug ? p.title : 'Nekko Agent docs',
      line: p.slug ? p.description : 'Set up, use and extend your personal AI agent.',
      path: p.slug ? `/docs/${p.slug}` : '/docs',
      hue: HUES[p.section] ?? '#b0609f',
    })),
    ...STANDALONE.map((c) => ({ ...c, hue: PAGE_HUE[c.name] })),
  ];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const font = (f) => `data:font/woff2;base64,${readFileSync(join(site, 'fonts', f)).toString('base64')}`;
const cat = (fill, cls = '', defs = '') =>
  `<svg class="${cls}" viewBox="${ART.x} ${ART.y} ${ART.w} ${ART.h}">${defs}<path fill="${fill}" fill-rule="evenodd" d="${HEAD}"/></svg>`;


// Nekko the mascot's head: the app's pixel cat (PixelHead in the desktop
// app's components/Mascot.tsx), on the same 32px grid: brand plum, white line
// and eyes, light-plum mouth. Happy (^ ^) eyes on the homepage.
const mascot = (cls, { happy = false } = {}) => `<svg class="${cls}" viewBox="2 3 28 25" shape-rendering="crispEdges">
<path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#190019" stroke="#ffffff" stroke-width="2" stroke-linejoin="miter"/>
<path fill="#ffffff" d="${happy ? 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z' : 'M11 15H13V18H11Z M20 15H22V18H20Z'}"/>
<path d="M15 20H17V21H15Z" fill="#c99bb3"/>
</svg>`;

const base = (hue) => `
@font-face { font-family: 'Inter Tight'; font-weight: 100 900; src: url(${font('inter-tight-latin-wght-normal.woff2')}); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url(${font('jetbrains-mono-latin-wght-normal.woff2')}); }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
body { position: relative; color: #fbf6f8; font-family: 'Inter Tight', sans-serif;
  background:
    radial-gradient(620px 520px at 88% 30%, color-mix(in srgb, ${hue} 55%, transparent), transparent 70%),
    radial-gradient(520px 420px at 10% 110%, color-mix(in srgb, ${hue} 22%, transparent), transparent 70%),
    linear-gradient(120deg, #0c0c11 0%, ${TILE} 55%, ${TILE_END} 100%); }
body::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background-image: radial-gradient(rgba(255,255,255,.07) 1px, transparent 1.2px); background-size: 22px 22px;
  -webkit-mask-image: linear-gradient(90deg, transparent 30%, #000 100%); }
.tile { width: 64px; height: 64px; border-radius: 16px; display: grid; place-items: center;
  background: linear-gradient(90deg, ${TILE}, ${TILE_END}); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.16), 0 10px 30px rgba(0,0,0,.4); }
.tile svg { width: 44px; }
.brand { display: flex; align-items: center; gap: 18px; font-weight: 700; font-size: 28px; letter-spacing: -.01em; }
.domain { font: 500 20px 'JetBrains Mono', monospace; color: #e6d0dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.domain b { color: #fff; font-weight: 600; }
`;

function pageHtml(c) {
  const size = c.title.length > 34 ? 62 : c.title.length > 18 ? 74 : 92;
  return `<!doctype html><html><head><style>${base(c.hue)}
.top { position: absolute; left: 80px; top: 64px; }
.body { position: absolute; left: 80px; top: 196px; width: 720px; }
h1 { margin: 0; font-weight: 800; font-size: ${size}px; line-height: 1.02; letter-spacing: -.035em; text-wrap: balance; }
p { margin: 26px 0 0; font-size: 30px; line-height: 1.3; color: #e6d0dc; max-width: 700px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.foot { position: absolute; left: 80px; right: 80px; bottom: 56px; display: flex; justify-content: space-between; align-items: center; }
.chip { font: 500 16px 'JetBrains Mono', monospace; letter-spacing: .18em; text-transform: uppercase; color: #fff;
  position: relative; white-space: nowrap; flex: none; margin-left: 24px; padding: 10px 16px; border-radius: 999px; background: color-mix(in srgb, ${c.hue} 30%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, ${c.hue} 70%, transparent); }
.hero { position: absolute; right: 70px; top: 150px; width: 320px; filter: drop-shadow(0 0 36px color-mix(in srgb, ${c.hue} 75%, transparent)) drop-shadow(0 20px 40px rgba(0,0,0,.5)); }
</style></head><body>
${mascot('hero')}
<div class="top brand"><div class="tile">${cat('#fff')}</div>Nekko Agent</div>
<div class="body"><h1>${esc(c.title)}</h1><p>${esc(c.line)}</p></div>
<div class="foot"><div class="domain"><b>nekkoagent.com</b>${esc(c.path)}</div><div class="chip">${esc(c.eyebrow)}</div></div>
</body></html>`;
}

function homeHtml() {
  const hue = '#c084b5';
  return `<!doctype html><html><head><style>${base(hue)}
.body { position: absolute; left: 80px; top: 92px; width: 680px; }
.eyebrow { font: 500 18px 'JetBrains Mono', monospace; letter-spacing: .24em; text-transform: uppercase; color: ${INK}; }
h1 { margin: 22px 0 0; font-weight: 800; font-size: 112px; line-height: .95; letter-spacing: -.045em; }
p { margin: 30px 0 0; font-size: 38px; line-height: 1.22; color: #e6d0dc; }
p b { color: #fff; font-weight: 600; }
.foot { position: absolute; left: 80px; bottom: 56px; display: flex; gap: 24px; align-items: center; }
.hero { position: absolute; right: 80px; top: 115px; width: 360px; filter: drop-shadow(0 0 48px color-mix(in srgb, ${hue} 85%, transparent)) drop-shadow(0 20px 40px rgba(0,0,0,.5)); }
.pill { font: 500 17px 'JetBrains Mono', monospace; color: #fff; padding: 9px 16px; border-radius: 999px; background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
</style></head><body>
${mascot('hero', { happy: true })}
<div class="body"><div class="eyebrow">by NekkoLabs</div><h1>Nekko Agent</h1>
<p><b>Your personal AI agent.</b><br/>On your computer and your phone.</p></div>
<div class="foot"><span class="domain"><b>nekkoagent.com</b></span><span class="pill">Free &amp; open source</span><span class="pill">Local or online AI</span></div>
</body></html>`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const cards = cardsFor(loadNav().pages);
  const browser = await chromium.launch(process.env.OG_BROWSER_CHANNEL ? { channel: process.env.OG_BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const shoot = async (html, path, opts) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path, ...opts });
  };
  await shoot(homeHtml(), join(site, 'og.png'), { type: 'png' });
  for (const c of cards) await shoot(pageHtml(c), join(outDir, `${c.name}.jpg`), { type: 'jpeg', quality: 88 });
  await browser.close();
  console.log(`wrote og.png and ${cards.length} page cards to apps/website/og/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
