import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLYPHS, ICONS, block, build, gentlefaceIcons, statusGlyphs, tokensCss } from './build-design-system.mjs';

test('block matches nested braces', () => {
  assert.equal(block('a { b { c: 1; } d: 2; } e { }', 'a').trim(), 'b { c: 1; } d: 2;');
  assert.throws(() => block('a { }', 'z'), /no "z \{" block/);
});

test('tokensCss keeps the Light Nekko and Dusk values and nothing from the presets', () => {
  const css = '@layer utilities {\n  :root {\n    --paper: #fff; --ink: #000; --accent: #5a2352; --info: #1f6680; --success-text: #226f49; --ease-out: ease; --q-group: 20px;\n  }\n  [data-theme=\'dark\'] {\n    --paper: #0b0c14;\n  }\n  [data-theme=\'dark\'][data-preset=\'nord\'] {\n    --paper: #1e222a;\n  }\n}';
  const out = tokensCss(css);
  assert.match(out, /:root \{\n[^}]*--paper: #fff;/);
  assert.match(out, /:root\[data-ds-theme='dusk'\] \{\n\s*--paper: #0b0c14;\n\}/);
  assert.doesNotMatch(out, /#1e222a/);
});

test('tokensCss refuses a theme block that lost a token the page reads', () => {
  assert.throws(() => tokensCss('@layer utilities {\n  :root {\n    --paper: #fff;\n  }\n  [data-theme=\'dark\'] { }\n}'), /lost --ink/);
});

test('the real sources give every token, icon and glyph the page uses', () => {
  const files = build();
  const tokens = files.get('ds/tokens.css');
  for (const t of ['--paper', '--surface', '--surface-2', '--line', '--ink-soft', '--ink-faint', '--accent-soft', '--ring', '--warning-text', '--attention', '--neutral', '--dur-fast', '--dur-med', '--dur-slow', '--q-tight', '--q-section', '--q-row', '--shadow-float', '--switch-knob']) {
    assert.ok(tokens.includes(`${t}:`), t);
  }
  const marks = files.get('ds/marks.js');
  for (const name of ICONS) assert.match(marks, new RegExp(`"${name}":"<`), name);
  for (const status of Object.keys(GLYPHS)) {
    assert.match(marks, new RegExp(`"${status}":"<`), status);
    assert.match(marks, new RegExp(`"${status}":\\{"tint":"--`), `${status} badge`);
  }
  // The page loads what the build writes.
  const html = readFileSync(new URL('../apps/website/design-system.html', import.meta.url), 'utf8');
  for (const name of files.keys()) assert.ok(html.includes(`/${name}`), `design-system.html loads /${name}`);
});

test('icon and glyph extraction unescape the source strings', () => {
  assert.deepEqual(gentlefaceIcons(`  'gear': { line: "<path d=\\"M1 1\\"/>", solid: "" },`, ['gear']), { gear: '<path d="M1 1"/>' });
  assert.deepEqual(statusGlyphs('export const DotIcon = (p: P) => (<S {...p}><circle className="x" r="1" /></S>);', { done: 'DotIcon' }), { done: '<circle class="x" r="1" />' });
  assert.throws(() => gentlefaceIcons('', ['gear']), /no line variant for "gear"/);
});
