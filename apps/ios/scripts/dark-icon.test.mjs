import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PNG } from 'pngjs';

const assets = new URL('../App/Assets.xcassets/AppIcon.appiconset/', import.meta.url);

test('primary icon keeps the default and declares an iOS dark luminosity asset', () => {
  const catalog = JSON.parse(readFileSync(new URL('Contents.json', assets), 'utf8'));
  assert.equal(catalog.images.find(image => !image.appearances).filename, 'AppIcon-1024.png');
  const dark = catalog.images.filter(image => image.appearances?.some(a => a.appearance === 'luminosity' && a.value === 'dark'));
  assert.equal(dark.length, 1);
  assert.equal(dark[0].platform, 'ios');
  assert.equal(dark[0].size, '1024x1024');
  const bytes = readFileSync(new URL(dark[0].filename, assets));
  assert.equal(bytes[25], 2, 'PNG is RGB, not RGBA');
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, 1024);
  assert.equal(png.height, 1024);
  let brandPixels = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    assert.equal(png.data[i + 3], 255);
    if (png.data[i] === 133 && png.data[i + 1] === 79 && png.data[i + 2] === 108) brandPixels++;
  }
  assert.ok(brandPixels > 20_000, 'the Nekko mark uses brand plum');
  assert.ok(png.data[0] < 40 && png.data[1] < 40 && png.data[2] < 40, 'dark ground');
});
