import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONNECTORS, PR_GLYPHS, PROVIDERS, androidDrawables, generate, iosAssets, root } from './phone-marks.mjs';

const files = generate();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the phones carry the desktop marks unchanged (run node scripts/phone-marks.mjs after changing one)', () => {
  for (const [path, text] of Object.entries(files)) {
    assert.ok(existsSync(join(root, path)), `missing ${path}`);
    assert.equal(read(path), text, `${path} differs from the desktop's drawing`);
  }
});

test('no mark is left over in the generated folders', () => {
  const sets = (folder) => readdirSync(join(root, iosAssets, folder)).filter((f) => f.endsWith('.imageset')).sort();
  assert.deepEqual(sets('ProviderMarks'), PROVIDERS.map((p) => `provider-${p}.imageset`).sort());
  assert.deepEqual(sets('PrIcons'), Object.values(PR_GLYPHS).map((n) => `${n}.imageset`).sort());
  assert.deepEqual(sets('ConnectorMarks'), Object.keys(CONNECTORS).map((k) => `connector-${k}.imageset`).sort());
  const drawables = readdirSync(join(root, androidDrawables)).filter((f) => /^(provider|pr)_/.test(f)).sort();
  assert.deepEqual(drawables, [...PROVIDERS.map((p) => `provider_${p}.xml`), ...Object.values(PR_GLYPHS).map((n) => `${n.replace('-', '_')}.xml`)].sort());
});

test('every phone connector kind has a mark', () => {
  const kinds = [...read('apps/ios/Protocol/Sources/NekkoKit/PhoneConnectors.swift').matchAll(/Kind\(id: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...kinds].sort(), Object.keys(CONNECTORS).sort());
});

test('each phone maps every provider mark the rules can name', () => {
  const swift = read('apps/ios/Protocol/Sources/NekkoProtocol/ChatCard.swift');
  const kotlin = read('apps/android/protocol/src/main/kotlin/com/nekko/protocol/ChatCard.kt');
  const rows = read('apps/android/app/src/main/java/com/nekko/android/ui/screens/ChatRowFacts.kt');
  for (const p of PROVIDERS) {
    assert.match(swift, new RegExp(`return "${p}"`), `ChatCard.swift never names ${p}`);
    assert.match(kotlin, new RegExp(`-> "${p}"`), `ChatCard.kt never names ${p}`);
    assert.match(rows, new RegExp(`"${p}" -> R\\.drawable\\.provider_${p}\\b`), `no drawable mapped for ${p}`);
  }
});
