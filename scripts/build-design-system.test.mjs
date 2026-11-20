import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPHS, ICONS, SPEC, block, build, declarations, gentlefaceIcons, renderPage, resolveValue, rules, shown, statusGlyphs, themes, tokensCss } from './build-design-system.mjs';

const THEME_CSS = "@layer utilities {\n  :root {\n    --paper: #fff; --ink: #000; --accent: #5a2352; --info: #1f6680; --success-text: #226f49; --ease-out: ease; --q-group: 20px;\n    --accent-soft: color-mix(in srgb, var(--accent) 13%, transparent);\n    --dur-med: 0.2s;\n  }\n  [data-theme='dark'] {\n    --paper: #0b0c14; /* Dusk */\n  }\n  [data-theme='dark'][data-preset='nord'] {\n    --paper: #1e222a;\n  }\n}";

test('block matches nested braces', () => {
  assert.equal(block('a { b { c: 1; } d: 2; } e { }', 'a').trim(), 'b { c: 1; } d: 2;');
  assert.throws(() => block('a { }', 'z'), /no "z \{" block/);
});

test('themes give Light Nekko and Dusk, Dusk inheriting what it does not override, and never a preset', () => {
  const t = themes(THEME_CSS);
  assert.equal(t.light['--paper'], '#fff');
  assert.equal(t.dusk['--paper'], '#0b0c14');
  assert.equal(t.dusk['--accent'], '#5a2352');
  assert.doesNotMatch(JSON.stringify(t), /#1e222a/);
  assert.deepEqual(declarations('/* x: y; */ --a: 1px;\n --b:\n  2px 3px;'), { '--a': '1px', '--b': '2px 3px' });
});

test('values read the way a person would write them', () => {
  const t = themes(THEME_CSS).light;
  assert.equal(resolveValue(t, '--accent-soft'), 'color-mix(in srgb, #5a2352 13%, transparent)');
  assert.equal(shown(t, '--accent-soft'), '#5a2352 at 13%');
  assert.equal(shown(t, '--dur-med'), '200ms');
});

test('tokensCss scopes both colourways, with an invert for the footer', () => {
  const out = tokensCss(THEME_CSS);
  assert.match(out, /:root, \.ds-light \{\n[^}]*--paper: #fff;/);
  assert.match(out, /:root\[data-ds-theme='dusk'\], \.ds-dusk, :root:not\(\[data-ds-theme='dusk'\]\) \.ds-invert \{/);
  assert.match(out, /:root\[data-ds-theme='dusk'\] \.ds-invert \{\n[^}]*--paper: #fff;/);
  assert.throws(() => tokensCss("@layer utilities {\n  :root {\n    --paper: #fff;\n  }\n  [data-theme='dark'] { }\n}"), /lost --ink/);
});

test('rules come from docs/design-system.md: six principles and the checklist', () => {
  const doc = '## Principles\n\n1. **Space before lines.** Gaps first.\n2. **B.** b\n3. **C.** c\n4. **D.** d\n5. **E.** e\n6. **F.** f\n\n## Checklist for a screen\n\n' + Array.from({ length: 9 }, (_, i) => `- [ ] Check \`${i}\`.`).join('\n') + '\n';
  const r = rules(doc);
  assert.deepEqual(r.principles[0], { rule: 'Space before lines.', detail: 'Gaps first.' });
  assert.equal(r.checklist[3], 'Check 3.');
  assert.throws(() => rules('## Principles\n1. **A.** a\n## Checklist for a screen\n'), /six principles/);
});

test('the template fails loudly on a placeholder it does not know', () => {
  const ctx = { t: themes(THEME_CSS), marks: { icons: {}, glyphs: {}, badges: {} }, rules: { principles: [], checklist: [] } };
  assert.equal(renderPage('<p>{{light:paper}} {{dusk:paper}}</p>', ctx), '<p>#fff #0b0c14</p>');
  assert.throws(() => renderPage('{{nope:x}}', ctx), /unknown placeholder \{\{nope:x\}\}/);
  assert.throws(() => renderPage('{{light:missing}}', ctx), /no token --missing/);
});

test('the real build: a static page an agent can read, plus Markdown and JSON', () => {
  const files = build();
  const html = files.get('design-system.html');
  assert.doesNotMatch(html, /\{\{|<!-- ds:/, 'every placeholder is filled');
  for (const href of ['/ds/tokens.css', '/design-system.md', '/design-system.json', '/design-system.css', '/design-system.js']) assert.ok(html.includes(href), href);
  assert.match(html, /<h1[^>]*>Quiet surfaces<\/h1>/);
  // Every value is in the HTML itself, so a reader without script sees the spec sheet.
  for (const [, rows] of SPEC) for (const [name] of rows) assert.ok(html.includes(`<code>${name}</code>`), name);
  assert.match(html, /<td><span class="chip" style="background: #0b0c14"><\/span><span class="v">#0b0c14<\/span><\/td>/, 'Dusk paper in the table');
  for (const s of Object.keys(GLYPHS)) assert.ok(html.includes(`data-status="${s}"`), `${s} glyph rendered`);
  const md = files.get('design-system.md');
  assert.match(md, /^# Nekko Agent design system: quiet surfaces/);
  assert.match(md, /\| `--paper` \| Page \| `#fbfbfd` \| `#0b0c14` \|/);
  assert.doesNotMatch(md, /\]\((?!https?:|#)/, 'every link in the Markdown is absolute');
  const json = JSON.parse(files.get('design-system.json'));
  assert.equal(json.colourways.dusk['--paper'], '#0b0c14');
  assert.equal(json.principles.length, 6);
  assert.ok(json.checklist.length >= 8);
  const tokens = files.get('ds/tokens.css');
  for (const t of ['--paper', '--win', '--surface-2', '--q-wash', '--shadow-lift', '--switch-knob', '--on-accent']) assert.ok(tokens.includes(`${t}:`), t);
});

test('icon and glyph extraction unescape the source strings', () => {
  assert.deepEqual(gentlefaceIcons(`  'gear': { line: "<path d=\\"M1 1\\"/>", solid: "" },`, ['gear']), { gear: '<path d="M1 1"/>' });
  assert.deepEqual(statusGlyphs('export const DotIcon = (p: P) => (<S {...p}><circle className="x" r="1" /></S>);', { done: 'DotIcon' }), { done: '<circle class="x" r="1" />' });
  assert.throws(() => gentlefaceIcons('', ['gear']), /no line variant for "gear"/);
  assert.ok(ICONS.includes('send'));
});
