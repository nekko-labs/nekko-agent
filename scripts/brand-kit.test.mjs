// The brand pack (spec/brand/brand-pack-and-trademarks.md): the committed files
// are what scripts/make-brand-kit.mjs draws, Nekko keeps his colours, the zip
// holds every file intact, and the docs page offers every file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { BRAND_DIR, COLOURS, EXTRA_FILES, ZIP_NAME, brandFiles, writeBrandZip, zip } from './make-brand-kit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

/** Width and height from a PNG's IHDR. */
function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Every entry of a zip, read back through its central directory. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24); // uncompressed
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataAt, dataAt + buf.readUInt32LE(local + 18));
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, size, `${name} size`);
    assert.equal(crc32(data), crc, `${name} CRC`);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

test('the committed SVGs are exactly what make-brand-kit draws, each with its PNG', () => {
  for (const f of brandFiles()) {
    const file = join(BRAND_DIR, f.name);
    assert.equal(readFileSync(file, 'utf8'), f.svg(), `${f.name} is stale: run node scripts/make-brand-kit.mjs`);
    const png = file.replace(/\.svg$/, '.png');
    assert.ok(existsSync(png), `${f.name} has a PNG`);
    assert.equal(pngSize(png).width, f.png, `${f.name}'s PNG is ${f.png} px wide`);
  }
  assert.ok(existsSync(join(BRAND_DIR, 'LICENSE.md')));
});

test('Nekko keeps the mascot rule: dark face on dark grounds, white face on light, never mixed', () => {
  const dark = readFileSync(join(BRAND_DIR, 'nekko-dark.svg'), 'utf8');
  const light = readFileSync(join(BRAND_DIR, 'nekko-light.svg'), 'utf8');
  assert.match(dark, /fill="#16161C" stroke="#F3E8EE"/);
  assert.match(light, /fill="#FFFFFF" stroke="#190019"/);
  for (const svg of [dark, light]) assert.match(svg, new RegExp(`fill="${COLOURS.nekkoDark.mouth}"`), 'the mouth is always the secondary');
  // The palette's colour-palette.md values, so a change there fails here first.
  const palette = read('spec/brand/colour-palette.md');
  for (const hex of ['#16161C', '#F3E8EE', '#854F6C']) assert.ok(palette.includes(hex), `colour-palette.md still names ${hex}`);
});

test('the zip writer round-trips and is reproducible', () => {
  const entries = [
    { name: 'a/text.txt', data: Buffer.from('nekko '.repeat(200)) },
    { name: 'a/tiny.txt', data: Buffer.from('x') },
  ];
  const one = zip(entries);
  assert.deepEqual(zip(entries), one, 'same input, same bytes');
  const back = unzip(one);
  for (const e of entries) assert.deepEqual(back.get(e.name), e.data);
});

test('the brand pack zip holds every file, unchanged, with the license and a README', () => {
  const names = writeBrandZip();
  const back = unzip(readFileSync(join(BRAND_DIR, ZIP_NAME)));
  assert.deepEqual([...back.keys()], names);
  for (const f of brandFiles()) {
    assert.deepEqual(back.get(`nekko-agent-brand-pack/${f.name}`), readFileSync(join(BRAND_DIR, f.name)));
    assert.ok(back.has(`nekko-agent-brand-pack/${f.name.replace(/\.svg$/, '.png')}`));
  }
  for (const f of EXTRA_FILES) assert.deepEqual(back.get(`nekko-agent-brand-pack/${f.name}`), readFileSync(f.from));
  assert.match(back.get('nekko-agent-brand-pack/README.txt').toString(), /LICENSE\.md/);
});

test('the docs page offers every file and the zip, and links the policy', () => {
  const page = read('docs/hub/brand.md');
  const links = [ZIP_NAME, EXTRA_FILES[0].name];
  for (const f of brandFiles()) links.push(f.name, f.name.replace(/\.svg$/, '.png'));
  for (const name of links) assert.ok(page.includes(`https://nekkoagent.com/brand/${name}`), `brand.md links ${name}`);
  assert.ok(page.includes('https://nekkoagent.com/docs/trademarks'));
  const nav = JSON.parse(read('docs/hub/nav.json'));
  const sources = nav.sections.flatMap((s) => s.pages.map((p) => p.source));
  assert.ok(sources.includes('docs/hub/brand.md') && sources.includes('TRADEMARKS.md'));
});

test('the README and the policy say MIT does not cover the marks', () => {
  assert.match(read('README.md'), /MIT license covers the code, not our names and marks/);
  assert.match(read('TRADEMARKS.md'), /The names and the brand assets are \*\*not\*\* licensed under MIT/);
  assert.match(read('apps/website/brand/LICENSE.md'), /\*\*not\*\* covered by Nekko Agent's MIT license/);
});
