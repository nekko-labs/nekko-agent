import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONNECTORS, DESKTOP_THEME_ICONS, PHONE_THEME_ICONS, PR_GLYPHS, PROVIDERS, androidDrawables, generate, iosAssets, root } from './phone-marks.mjs';

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
  const themes = [...DESKTOP_THEME_ICONS, ...PHONE_THEME_ICONS];
  assert.deepEqual(sets('ThemeIcons'), themes.map((n) => `theme-${n}.imageset`).sort());
  const themeDrawables = readdirSync(join(root, androidDrawables)).filter((f) => f.startsWith('theme_')).sort();
  assert.deepEqual(themeDrawables, themes.map((n) => `theme_${n.replace(/-/g, '_')}.xml`).sort());
});

test('both phones give every theme the same icon, and the desktop nine match its picker', () => {
  const kotlin = read('apps/android/app/src/main/java/com/nekko/android/ui/theme/ThemeIcons.kt');
  const swift = read('apps/ios/App/Platform/ThemeIcons.swift');
  const android = Object.fromEntries([...kotlin.matchAll(/"([^"]+)" to R\.drawable\.theme_([a-z_]+)/g)].map((m) => [m[1], m[2].replace(/_/g, '-')]));
  const ios = Object.fromEntries([...swift.matchAll(/"([^"]+)": "theme-([a-z-]+)"/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(android).length > 20);
  assert.deepEqual(ios, android);
  assert.match(kotlin, /computer: Int = R\.drawable\.theme_laptop/);
  assert.match(swift, /computer = "theme-laptop"/);
  // The desktop's picker (theme-icons.tsx THEME_ICON) and the phones agree on its nine.
  const desktop = Object.fromEntries([...read('apps/desktop/src/renderer/theme-icons.tsx').matchAll(/^  '?([a-z-]+)'?: '([a-z-]+)',$/gm)].map((m) => [m[1], m[2]]));
  const phone = { 'x-plum-white': ios.Nekko, nebula: ios.nebula, terminal: ios.terminal, nord: ios.nord, ember: ios.ember,
    'x-forest-white': ios.Forest, 'x-blueberry-white': ios.Blueberry, autumn: ios.autumn, winter: ios.winter };
  assert.deepEqual(desktop, phone);
  for (const icon of new Set(Object.values(ios))) assert.ok([...DESKTOP_THEME_ICONS, ...PHONE_THEME_ICONS].includes(icon), `no asset for ${icon}`);
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
