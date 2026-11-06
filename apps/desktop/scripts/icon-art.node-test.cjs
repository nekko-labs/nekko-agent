const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { iconSvg, bannerSvg, bareMarkSvg, INK, ICON_INK, TILE, TILE_END } = require('./icon-art.cjs');

const hash = (svg) => createHash('sha256').update(svg).digest('hex');
// Frozen output from #1943: the fix must not alter white icon art at any size.
const icons = [
  [16, '52e7c99a898d6a9273c61371f91ea8fedee2a2066978bc7ac571f8d25dfc5fa5'],
  [24, 'ee14d20d7729515edea36aaea951e8979f2d9f038a6fd3e75cf2a970aef7297b'],
  [32, 'a42484295ef3d2beafbd87507d1f530ddd6b88b7b9c6349ebdb19a330fa6b12a'],
  [48, '3aa6ba59a253ddf5f36087923435fd848ca30917e75784ba41d111d0492051cb'],
  [64, 'd2f8ec6ec5def4230b6bbd7d8e44c7b74f8f52633f9fbf2a6d164a17fd096bf4'],
  [128, '13fb2fa6f58fb39f3ee36fb9ae2df4a7e4eb0db81038340e06782cab6d85dda9'],
  [256, '105bac1e243a2f9350625875772c0c461bb4873f545dae58a4ef32b9c54a4e46'],
  [512, 'e49cde8df78e1d6ee381b3d88f713508c4ae7d5329328aadb0632c65cc69c960'],
  [1024, '0e0b5bc8ce99b948559a7c150fbacf9c1fba2b727ddb31aa377a5c0f95d96235'],
];

for (const [size, expected] of icons) {
  test(`app icon stays white with unchanged geometry and gradient at ${size}px`, () => {
    const svg = iconSvg(size);
    assert.equal(ICON_INK, '#FFFFFF');
    assert.match(svg, /fill="#FFFFFF" fill-rule="evenodd"/);
    assert.equal(hash(svg), expected);
  });

  test(`explicit ink changes only the cat fill and thickening stroke at ${size}px`, () => {
    const white = iconSvg(size);
    const plum = iconSvg(size, size, INK);
    assert.equal(INK, '#854F6C');
    assert.equal(plum, white.replaceAll('#FFFFFF', '#854F6C'));
    assert.match(plum, /fill="#854F6C" fill-rule="evenodd"/);
    if (size < 64) assert.match(plum, /stroke="#854F6C"/);
  });
}

// Frozen banner output from f5d8f34b^ (before #1943), using make-icons.cjs's
// actual layouts. Exact equality protects geometry, colours, text and gradients.
const banners = [
  {
    name: 'header', w: 150, h: 57,
    opts: { markSize: 40, markX: 10, markY: 8, title: 'Nekko Agent', titleSize: 12, layout: 'row' },
    expected: '9f941ca454be1c8d7b607c66f6e361ab77f5894d152d53c12b5a3b892979d7b7',
    scaled: '533a27b7c5640a79000d60f023f37792bfdbd8a9d6e077aad7c509893dbe6b70',
  },
  {
    name: 'sidebar', w: 164, h: 314,
    opts: { markSize: 88, markX: 38, markY: 62, title: 'Nekko Agent', tagline: 'Local-first AI coding', titleSize: 22, layout: 'column' },
    expected: '62db2ffb4909d9eeeb5788dc0332e8464d1d017ccf4c41886bd25f8f5b9b0380',
    scaled: '52091334f2500bea01e708d3b74f1ec4d01a1d6f9f15905b66f3b46e1a7d87f9',
  },
];

for (const { name, w, h, opts, expected, scaled } of banners) {
  test(`installer ${name} preserves the original plum art, including supersampling`, () => {
    const svg = bannerSvg(w, h, opts);
    assert.doesNotMatch(svg, /#FFFFFF/i);
    assert.match(svg, /fill="#854F6C" fill-rule="evenodd"/);
    assert.equal(hash(svg), expected);
    assert.equal(hash(bannerSvg(w, h, opts, w * 2, h * 2)), scaled);
  });

  test(`committed installer ${name} has the expected dimensions and plum, not white, cat pixels`, () => {
    const filename = name === 'header' ? 'installerHeader.bmp' : 'installerSidebar.bmp';
    const bmp = readFileSync(join(__dirname, '../build', filename));
    assert.equal(bmp.toString('ascii', 0, 2), 'BM');
    assert.equal(bmp.readInt32LE(18), w);
    assert.equal(bmp.readInt32LE(22), h);
    assert.equal(bmp.readUInt16LE(28), 24);
    const offset = bmp.readUInt32LE(10);
    const stride = Math.ceil(w * 3 / 4) * 4;
    let plumPixels = 0;
    for (let y = opts.markY; y < opts.markY + opts.markSize; y++) {
      for (let x = opts.markX; x < opts.markX + opts.markSize; x++) {
        const at = offset + (h - 1 - y) * stride + x * 3;
        const rgb = [bmp[at + 2], bmp[at + 1], bmp[at]];
        if (rgb.every((v, i) => Math.abs(v - [133, 79, 108][i]) <= 4)) plumPixels++;
        // Resampling can overshoot plum slightly, but never approaches white.
        assert.ok(rgb.every((v) => v < 200), `unexpected bright cat pixel at ${x},${y}`);
      }
    }
    assert.ok(plumPixels > 0, 'cat crop must contain plum ink');
  });
}

test('app SVG generation still matches the committed desktop and web icons exactly', () => {
  assert.equal(iconSvg(512), readFileSync(join(__dirname, '../build/icon.svg'), 'utf8'));
  assert.equal(iconSvg(512, 64), readFileSync(join(__dirname, '../src/renderer/public/icon.svg'), 'utf8'));
});

test('non-icon marks and the plum gradient keep their original colours', () => {
  assert.equal(TILE, '#190019');
  assert.equal(TILE_END, '#5A2352');
  assert.match(bareMarkSvg(512), /fill="#854F6C" fill-rule="evenodd"/);
  assert.doesNotMatch(bareMarkSvg(512), /#FFFFFF/i);
});
