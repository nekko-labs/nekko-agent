const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { PNG } = require('pngjs');
const { iconSvg, bannerSvg, bareMarkSvg, logoSvg, HEAD, INK, ICON_INK, TILE, TILE_END } = require('./icon-art.cjs');

const root = join(__dirname, '../../..');
const text = (file) => readFileSync(join(root, file), 'utf8');
const legacy = /#(?:190019|5a2352|854f6c|c084b5)\b/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  test(`app icon uses cream on the green tile at ${size}px, preserving the cat geometry`, () => {
    const svg = iconSvg(size);
    assert.equal(ICON_INK, '#F2F1E9');
    assert.equal(TILE, '#101714');
    assert.equal(TILE_END, '#263D2D');
    assert.ok(svg.includes(`d="${HEAD}"`));
    assert.ok(svg.includes(`fill="${ICON_INK}"`));
    assert.ok(svg.includes(`stop-color="${TILE}"`));
    assert.ok(svg.includes(`stop-color="${TILE_END}"`));
    assert.doesNotMatch(svg, legacy);
    assert.equal(iconSvg(size, size, INK), svg.replaceAll(ICON_INK, INK));
    if (size < 64) assert.ok(svg.includes(`stroke="${ICON_INK}"`));
  });
}

test('the icon and live in-app mark retain identical outline geometry', () => {
  assert.ok(text('apps/desktop/src/renderer/components/BrandMark.tsx').includes(`'${HEAD}'`));
});

const banners = [
  { name: 'header', w: 150, h: 57, opts: { markSize: 40, markX: 10, markY: 8, title: 'Nekko Agent', titleSize: 12, layout: 'row' } },
  { name: 'sidebar', w: 164, h: 314, opts: { markSize: 88, markX: 38, markY: 62, title: 'Nekko Agent', titleSize: 22, layout: 'column' } },
];
for (const { name, w, h, opts } of banners) {
  test(`installer ${name} uses legible sage on green, including its committed bitmap`, () => {
    assert.equal(INK, '#A7C8AC');
    for (const svg of [bannerSvg(w, h, opts), bannerSvg(w, h, opts, w * 2, h * 2)]) {
      assert.doesNotMatch(svg, legacy);
      assert.ok(svg.includes(`fill="${INK}"`));
      assert.match(svg, /Nekko Agent/);
    }
    const file = name === 'header' ? 'installerHeader.bmp' : 'installerSidebar.bmp';
    const bmp = readFileSync(join(__dirname, '../build', file));
    assert.equal(bmp.toString('ascii', 0, 2), 'BM');
    assert.equal(bmp.readInt32LE(18), w);
    assert.equal(bmp.readInt32LE(22), h);
    assert.equal(bmp.readUInt16LE(28), 24);
    const offset = bmp.readUInt32LE(10), stride = Math.ceil(w * 3 / 4) * 4;
    let sage = 0;
    for (let y = opts.markY; y < opts.markY + opts.markSize; y++) {
      for (let x = opts.markX; x < opts.markX + opts.markSize; x++) {
        const at = offset + (h - 1 - y) * stride + x * 3;
        if ([bmp[at + 2], bmp[at + 1], bmp[at]].every((v, i) => Math.abs(v - [167, 200, 172][i]) <= 4)) sage++;
      }
    }
    assert.ok(sage > 0, 'cat crop contains sage ink');
  });
}

test('committed web, desktop and iOS vectors match their generators', () => {
  assert.equal(iconSvg(512), text('apps/desktop/build/icon.svg'));
  assert.equal(iconSvg(512, 64), text('apps/desktop/src/renderer/public/icon.svg'));
  assert.equal(iconSvg(32).replace(/ width="\d+" height="\d+"/, ''), text('apps/website/favicon.svg'));
  assert.equal(logoSvg(), text('apps/website/logo.svg'));
  for (const [file, color, background] of [['icon.svg', ICON_INK, 'gradient'], ['icon-dark.svg', INK, TILE]]) {
    assert.equal(bareMarkSvg(1024, { color, background, inset: 0.687 }), text(`apps/ios/App/Assets.xcassets/AppIcon.appiconset/${file}`));
  }
});

function checkPng(bytes, size) {
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, size);
  assert.equal(png.height, size);
  let green = 0, cream = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b, a] = png.data.subarray(i, i + 4);
    if (a === 0) continue;
    assert.ok(!(r > g + 8 && b > g + 8), `no plum pixels: ${r},${g},${b}`);
    if (g > r + 3 && r < 80) green++;
    if (r > 150 && g > 190 && b > 150) cream++;
  }
  assert.ok(green > 0, 'green ground');
  assert.ok(cream > 0, 'cream or sage mark');
  return png;
}

for (const [file, size] of [
  ['apps/desktop/build/icon.png', 512],
  ['apps/desktop/src/renderer/public/icon-512.png', 512],
  ['apps/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', 1024],
  ['apps/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-Dark-1024.png', 1024],
  ['apps/ios/Watch/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', 1024],
]) {
  test(`${file} contains current green/cream artwork, not stale purple pixels`, () => {
    const bytes = readFileSync(join(root, file));
    const png = checkPng(bytes, size);
    if (file.includes('/ios/')) {
      assert.equal(bytes[25], 2, 'native icon is opaque RGB');
      for (let i = 3; i < png.data.length; i += 4) assert.equal(png.data[i], 255);
    }
  });
}

test('desktop/PWA and iOS/Watch raster copies stay synchronized', () => {
  const same = (a, b) => assert.equal(hash(readFileSync(join(root, a))), hash(readFileSync(join(root, b))));
  same('apps/desktop/build/icon.png', 'apps/desktop/src/renderer/public/icon-512.png');
  same('apps/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', 'apps/ios/Watch/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
});

test('Windows ICO contains correct PNG dimensions and current art for every requested size', () => {
  const ico = readFileSync(join(__dirname, '../build/icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(4), sizes.length);
  sizes.forEach((size, i) => {
    const at = 6 + i * 16;
    assert.equal(ico[at] || 256, size);
    assert.equal(ico[at + 1] || 256, size);
    const offset = ico.readUInt32LE(at + 12), length = ico.readUInt32LE(at + 8);
    checkPng(ico.subarray(offset, offset + length), size);
  });
});

test('Android launcher uses the current opaque ARGB palette without recoloring widget surfaces', () => {
  const colors = text('apps/android/app/src/main/res/values/colors.xml');
  assert.match(colors, /name="ic_launcher_background">#FF101714</);
  assert.match(colors, /name="ic_launcher_mark">#FFF2F1E9</);
  assert.match(colors, /name="widget_surface">#FFFFFFFF</);
  const tile = text('apps/android/app/src/main/res/drawable/ic_launcher_background.xml');
  assert.ok(tile.includes(`android:startColor="${TILE}"`));
  assert.ok(tile.includes(`android:endColor="${TILE_END}"`));
  assert.doesNotMatch(tile, legacy);
});

test('every live favicon, logo and social-card reference is cache-busted consistently', () => {
  for (const file of ['apps/website/index.html', 'apps/website/privacy.html', 'scripts/build-docs.mjs']) {
    const source = text(file);
    const refs = [...source.matchAll(/(?:favicon\.svg|logo\.svg|og\.png)\?v=([^"\s]+)/g)];
    assert.ok(refs.length >= 2);
    for (const ref of refs) assert.equal(ref[1], 'green-cream-1');
  }
  const html = text('apps/desktop/src/renderer/index.html');
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\.\/icon.svg\?v=green-cream-1"/);
  assert.match(html, /rel="apple-touch-icon" href="\.\/icon-512.png\?v=green-cream-1"/);
  const manifest = JSON.parse(text('apps/desktop/src/renderer/public/manifest.webmanifest'));
  assert.equal(manifest.background_color, TILE);
  assert.equal(manifest.theme_color, TILE);
  assert.equal(manifest.icons[0].src, 'icon-512.png?v=green-cream-1');
});

test('the old Agent Nekko social card is replaced by the current brand banner', () => {
  const png = PNG.sync.read(readFileSync(join(root, 'apps/website/og.png')));
  assert.equal(png.width, 1200);
  assert.equal(png.height, 630);
  assert.ok(text('scripts/make-site-icon.cjs').includes('docs/brand/nekko-banner-1280x640.png'));
});
