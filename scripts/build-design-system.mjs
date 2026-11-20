// nekkoagent.com/design-system, built from the app's own source at deploy time
// (build-docs.mjs calls it), so the page never drifts from what the app ships.
//
// Reads:
//   apps/desktop/src/renderer/styles.css           Light Nekko (:root) and Dusk tokens
//   apps/desktop/src/renderer/gentleface-icons.tsx the control icons
//   apps/desktop/src/renderer/icons.tsx            the status glyphs
//   apps/desktop/src/renderer/components/WallMascot.tsx  the window badges
//   docs/design-system.md                          the rules, principles and checklist
//   scripts/design-system/page.html                the page template
// Writes (generated, gitignored):
//   apps/website/design-system.html  the page, with every value and glyph baked in, so it reads without script
//   apps/website/design-system.md    the same system as Markdown, for agents
//   apps/website/design-system.json  the tokens, principles and checklist as data, for agents
//   apps/website/ds/tokens.css       the two colourways, for the page's own styles
//
//   node scripts/build-design-system.mjs   write them on their own
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(repo, 'apps', 'desktop', 'src', 'renderer');
const ORIGIN = 'https://nekkoagent.com';
const GITHUB = 'https://github.com/nekko-labs/nekko-agent/blob/main';

// The control icons the page may use, by their GfIconName.
export const ICONS = ['settings', 'search', 'send', 'folder-open', 'terminal', 'workflow', 'server', 'globe', 'image', 'archive', 'palette', 'sparkles', 'lock', 'cloud', 'puzzle', 'keyboard', 'hand', 'bots'];
// The status glyphs StatusIcon draws, by their export in icons.tsx.
export const GLYPHS = { working: 'RocketIcon', input: 'QuestionIcon', error: 'WarningIcon', idle: 'SleepIcon', done: 'CheckIcon' };
export const STATUS_WORDS = { working: 'Working', input: 'Needs you', error: 'Stopped on an error', idle: 'Watching', done: 'Done' };

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The body of the first `selector {` block at or after `from`, braces matched. */
export function block(css, selector, from = 0) {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no "${selector} {" block in styles.css`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed "${selector}" block in styles.css`);
}

/** The Light Nekko and Dusk theme blocks of the utilities layer. */
export function themeBlocks(css) {
  const layer = css.indexOf('@layer utilities {\n  :root {');
  if (layer < 0) throw new Error('styles.css has no "@layer utilities { :root {" theme block');
  const light = block(css, ':root', layer);
  const dusk = block(css, "[data-theme='dark']", layer);
  for (const token of ['--paper', '--ink', '--accent', '--info', '--success-text', '--ease-out', '--q-group']) {
    if (!light.includes(`${token}:`)) throw new Error(`the :root theme block lost ${token}`);
  }
  return { light, dusk };
}

/** `--name: value;` declarations of a block, comments dropped, values on one line. */
export function declarations(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}

/** Each theme's tokens: Dusk is Light Nekko with Dusk's overrides. */
export function themes(css) {
  const { light, dusk } = themeBlocks(css);
  const l = declarations(light);
  return { light: l, dusk: { ...l, ...declarations(dusk) } };
}

/** A token's value with var() references to other tokens substituted, for display. */
export function resolveValue(tokens, name, depth = 0) {
  const v = tokens[name];
  if (v == null) throw new Error(`no token ${name}`);
  if (depth > 6) return v;
  return v.replace(/var\((--[\w-]+)\)/g, (all, ref) => (tokens[ref] != null && ref !== '--shadow-ink' ? resolveValue(tokens, ref, depth + 1) : all));
}

/** How a value reads in a table: "#5a2352 at 13%" for a soft tint, the hex otherwise. */
export function shown(tokens, name) {
  const v = resolveValue(tokens, name);
  const mix = v.match(/^color-mix\(in srgb, (.+) (\d+)%, transparent\)$/);
  if (mix) return `${mix[1]} at ${mix[2]}%`;
  return v.replace(/^0?\.(\d+)s$/, (_, d) => `${Number(`0.${d}`) * 1000}ms`).replace(/^(\d+(?:\.\d+)?)s$/, (_, d) => `${Number(d) * 1000}ms`);
}

/** The theme tokens as CSS: :root and .ds-light are Light Nekko; the dusk theme and .ds-dusk are Dusk. */
export function tokensCss(css) {
  const { light, dusk } = themeBlocks(css);
  const tidy = (body) => body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return [
    '/* Generated from apps/desktop/src/renderer/styles.css by scripts/build-design-system.mjs. Do not edit. */',
    `:root, .ds-light {\n${tidy(light)}\n}`,
    // A .ds-light or .ds-dusk section sets its own tokens, which beat the ones it inherits from the page;
    // .ds-invert takes whichever colourway the page is not wearing.
    `:root[data-ds-theme='dusk'], .ds-dusk, :root:not([data-ds-theme='dusk']) .ds-invert {\n${tidy(dusk)}\n}`,
    `:root[data-ds-theme='dusk'] .ds-invert {\n${tidy(light)}\n}`,
    '',
  ].join('\n');
}

/** Each named icon's line SVG markup, from the PATHS table in gentleface-icons.tsx. */
export function gentlefaceIcons(source, names = ICONS) {
  const out = {};
  for (const name of names) {
    const m = source.match(new RegExp(`['"]?${escapeRegExp(name)}['"]?:\\s*\\{\\s*line:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) throw new Error(`gentleface-icons.tsx has no line variant for "${name}"`);
    out[name] = JSON.parse(`"${m[1]}"`);
  }
  return out;
}

/** Each status glyph's inner SVG, from its `export const X = (p: P) => (<S {...p}>…</S>)` in icons.tsx. */
export function statusGlyphs(source, glyphs = GLYPHS) {
  const out = {};
  for (const [status, name] of Object.entries(glyphs)) {
    const m = source.match(new RegExp(`export const ${escapeRegExp(name)} = \\(p: P\\) => \\(?\\s*<S \\{\\.\\.\\.p\\}>([\\s\\S]*?)</S>`));
    if (!m) throw new Error(`icons.tsx has no ${name}`);
    out[status] = m[1].replace(/className=/g, 'class=').replace(/\s*\n\s*/g, '').trim();
  }
  return out;
}

/** Each window badge (tint token, label, glyph path) from the BADGE table in WallMascot.tsx. */
export function wallBadges(source) {
  const out = {};
  for (const m of source.matchAll(/^\s+(\w+): \{ tint: 'var\((--[\w-]+)\)', label: '([^']+)', glyph: <path d="([^"]+)" \/> \},$/gm)) {
    out[m[1]] = { tint: m[2], label: m[3], path: m[4] };
  }
  const missing = Object.keys(GLYPHS).filter((s) => !out[s]);
  if (missing.length) throw new Error(`WallMascot.tsx has no badge for ${missing.join(', ')}`);
  return out;
}

/** The principles and the screen checklist, from docs/design-system.md. */
export function rules(doc) {
  const section = (title) => {
    const start = doc.indexOf(`## ${title}\n`);
    if (start < 0) throw new Error(`docs/design-system.md has no "## ${title}"`);
    const next = doc.indexOf('\n## ', start + 4);
    return doc.slice(start, next < 0 ? undefined : next);
  };
  const strip = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();
  const principles = [...section('Principles').matchAll(/^\d+\. \*\*(.+?)\*\* (.+)$/gm)].map((m) => ({ rule: strip(m[1]), detail: strip(m[2]) }));
  const checklist = [...section('Checklist for a screen').matchAll(/^- \[ \] (.+)$/gm)].map((m) => strip(m[1]));
  if (principles.length !== 6) throw new Error(`expected six principles in docs/design-system.md, found ${principles.length}`);
  if (checklist.length < 8) throw new Error('the screen checklist in docs/design-system.md looks truncated');
  return { principles, checklist };
}

// ---- The spec sheet: every value the page and the JSON report, grouped.
export const SPEC = [
  ['Neutrals', [
    ['--paper', 'Page'],
    ['--surface', 'Popovers, menus, tooltips'],
    ['--surface-2', 'Raised: a secondary button on hover'],
    ['--line', 'The one hairline'],
    ['--ink', 'Titles, what you scan for'],
    ['--ink-soft', 'Supporting text, icons at rest'],
    ['--ink-faint', 'Metadata and help'],
  ]],
  ['Intent', [
    ['--accent', 'The one primary button, focus, selection, links, a switch that is on'],
    ['--accent-soft', 'Behind a selected row'],
    ['--ring', 'The focus halo'],
  ]],
  ['Information', [
    ['--info', 'Notices, "New", tips, chart series three'],
    ['--accent-2', 'Chart series two'],
  ]],
  ['State', [
    ['--success', 'Working, done, connected: glyphs and dots'],
    ['--success-text', 'The same, as words'],
    ['--warning', 'Expiring, best so far'],
    ['--warning-text', 'The same, as words'],
    ['--danger', 'Errors and removal'],
    ['--danger-text', 'The same, as words'],
    ['--attention', 'An agent waiting on you'],
    ['--attention-text', 'The same, as words'],
    ['--neutral', 'Watching, offline'],
  ]],
  ['Space', [
    ['--q-tight', 'Coupled pairs: a title and its subtext'],
    ['--q-inline', 'Row padding, name to meta'],
    ['--q-group', 'Panel padding, group to group'],
    ['--q-section', 'Section to section'],
    ['--q-row', 'A row on a page'],
    ['--q-row-dense', 'A row in a popover or menu'],
  ]],
  ['Motion', [
    ['--ease-out', 'The one curve, for everything'],
    ['--dur-fast', 'Hover and press'],
    ['--dur-med', 'Toggle, select, open'],
    ['--dur-slow', 'Meters and theme changes'],
  ]],
];
export const TYPE = [
  ['Page title', '20 / 600', 'ink'],
  ['Section heading', '16 / 600', 'ink'],
  ['Row title, page', '14 / 500', 'ink'],
  ['Row title, popover', '12 / 500', 'ink'],
  ['Group label', '12 / 500', 'ink-soft'],
  ['Detail, meta', '12 or 11 / 400', 'ink-faint'],
];
const isColour = (v) => /^(#|rgb|color-mix)/.test(v);

export function specRows(t) {
  const cell = (tokens, name) => {
    const v = resolveValue(tokens, name);
    const chip = isColour(v) ? `<span class="chip" style="background: ${esc(v)}"></span>` : '';
    return `<td>${chip}<span class="v">${esc(shown(tokens, name))}</span></td>`;
  };
  const groups = SPEC.map(([group, rows]) => `
        <tbody>
          <tr class="spec-group"><th colspan="4" scope="colgroup">${group}</th></tr>
${rows.map(([name, use]) => `          <tr><th scope="row"><code>${name}</code></th><td class="use">${esc(use)}</td>${cell(t.light, name)}${cell(t.dusk, name)}</tr>`).join('\n')}
        </tbody>`);
  groups.push(`
        <tbody>
          <tr class="spec-group"><th colspan="4" scope="colgroup">Type</th></tr>
${TYPE.map(([role, size, ink]) => `          <tr><th scope="row">${role}</th><td class="use">Geist ${size}</td><td><span class="chip" style="background: ${esc(t.light[`--${ink}`])}"></span><span class="v">${ink}</span></td><td><span class="chip" style="background: ${esc(t.dusk[`--${ink}`])}"></span><span class="v">${ink}</span></td></tr>`).join('\n')}
        </tbody>`);
  return groups.join('');
}

// ---- Marks rendered into the page.
const glyphSvg = (marks, s) => `<svg viewBox="0 0 24 24" aria-hidden="true">${marks.glyphs[s]}</svg>`;
export const glyphHtml = (marks, s) =>
  `<span class="glyph${s === 'working' ? ' status-rocket' : ''}${['error', 'idle', 'done'].includes(s) ? ' small' : ''}" data-status="${s}" role="img" aria-label="${STATUS_WORDS[s]}">${glyphSvg(marks, s)}</span>`;
const MOODS = { done: 'happy', idle: 'sleeping' };
export const nekkoHead = (size) => `<svg viewBox="0 0 32 32" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true"><path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#16161c" stroke="#f3e8ee" stroke-width="2" /><path class="eyes-open" d="M11 15H13V18H11Z M20 15H22V18H20Z" fill="#ffffff" /><path class="eyes-happy" d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z" fill="#ffffff" /><path class="eyes-closed" d="M10 17H14V18H10Z M19 17H23V18H19Z" fill="#ffffff" /><path d="M15 20H17V21H15Z" fill="#854f6c" /></svg>`;
export const mascotHtml = (marks, s) =>
  `<span class="wall-mascot" data-mood="${MOODS[s] || ''}" role="img" aria-label="${STATUS_WORDS[s]}">${nekkoHead(20)}<span class="wall-mascot-badge" style="--badge: var(${marks.badges[s].tint})"><svg viewBox="0 0 24 24"><path d="${marks.badges[s].path}" /></svg></span></span>`;
const iconHtml = (marks, name) => `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${marks.icons[name]}</svg>`;

/** Fill the template's placeholders. Unknown ones are an error, so a typo never ships. */
export function renderPage(template, { t, marks, rules: r }) {
  // Function replacements: built only when the marker is there, and never read for $ patterns.
  let html = template
    .replace('<!-- ds:spec -->', () => specRows(t))
    .replace('<!-- ds:principles -->', () => r.principles.map((p) => `<li><span class="rule-title">${esc(p.rule)}</span> <span class="rule-detail">${esc(p.detail)}</span></li>`).join('\n'))
    .replace('<!-- ds:checklist -->', () => r.checklist.map((c) => `<li>${esc(c)}</li>`).join('\n'))
    .replace('<!-- ds:marks -->', () => `<script type="application/json" id="ds-marks">${JSON.stringify(marks).replace(/</g, '\\u003c')}</script>`);
  html = html.replace(/\{\{(\w+):([\w-]+)\}\}/g, (all, kind, arg) => {
    if (kind === 'light' || kind === 'dusk') return esc(shown(t[kind], `--${arg}`));
    if (kind === 'glyph' && marks.glyphs[arg]) return glyphHtml(marks, arg);
    if (kind === 'mascot' && marks.badges[arg]) return mascotHtml(marks, arg);
    if (kind === 'icon' && marks.icons[arg]) return iconHtml(marks, arg);
    if (kind === 'head') return nekkoHead(Number(arg));
    if (kind === 'word' && STATUS_WORDS[arg]) return STATUS_WORDS[arg];
    throw new Error(`unknown placeholder ${all} in the design system template`);
  });
  if (/<!-- ds:\w+ -->/.test(html)) throw new Error(`unfilled ${html.match(/<!-- ds:\w+ -->/)[0]} in the design system template`);
  return html;
}

/** The Markdown version: how an agent uses it, the rules from docs/design-system.md, then every value. */
export function markdown(doc, t) {
  // Repo-relative links in the doc point at GitHub from the website.
  const body = doc
    .replace(/^# .*\n/, '')
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, link) => `](${GITHUB}/${posixJoin('docs', link)})`);
  const table = (rows) => [
    '| Token | Use | Light Nekko | Dusk |',
    '| --- | --- | --- | --- |',
    ...rows.map(([name, use]) => `| \`${name}\` | ${use} | \`${shown(t.light, name)}\` | \`${shown(t.dusk, name)}\` |`),
  ].join('\n');
  return [
    '# Nekko Agent design system: quiet surfaces',
    '',
    `> The design system behind Nekko Agent, in two colourways: Light Nekko and Dusk. Interactive page: ${ORIGIN}/design-system. Tokens as JSON: ${ORIGIN}/design-system.json. Source: ${GITHUB}/docs/design-system.md. MIT licence.`,
    '',
    '## For agents',
    '',
    'When you build or change an interface in this style: read the rules below, use the tokens by name (never a hex value), check every screen against the checklist at the end, and look at it in both colourways at 360px and desktop width.',
    body.trimEnd(),
    '',
    '## Token values',
    '',
    'Generated from `apps/desktop/src/renderer/styles.css` at deploy time.',
    '',
    ...SPEC.flatMap(([group, rows]) => [`### ${group}`, '', table(rows), '']),
  ].join('\n');
}
const posixJoin = (base, link) => {
  const parts = `${base}/${link}`.split('/');
  const out = [];
  for (const p of parts) (p === '..' ? out.pop() : p !== '.' && out.push(p));
  return out.join('/');
};

/** The JSON version. */
export function json(t, r) {
  const pick = (tokens) => Object.fromEntries(SPEC.flatMap(([, rows]) => rows.map(([name]) => [name, resolveValue(tokens, name)])));
  return {
    name: 'Nekko Agent quiet design system',
    url: `${ORIGIN}/design-system`,
    markdown: `${ORIGIN}/design-system.md`,
    source: `${GITHUB}/docs/design-system.md`,
    license: 'MIT',
    fonts: { interface: 'Geist', code: 'Geist Mono' },
    principles: r.principles,
    colourways: { 'light-nekko': pick(t.light), dusk: pick(t.dusk) },
    tokenUse: Object.fromEntries(SPEC.flatMap(([group, rows]) => rows.map(([name, use]) => [name, { group, use }]))),
    type: TYPE.map(([role, size, ink]) => ({ role, size, ink })),
    checklist: r.checklist,
  };
}

export function build() {
  const css = readFileSync(join(renderer, 'styles.css'), 'utf8');
  const doc = readFileSync(join(repo, 'docs', 'design-system.md'), 'utf8');
  const t = themes(css);
  const r = rules(doc);
  const marks = {
    icons: gentlefaceIcons(readFileSync(join(renderer, 'gentleface-icons.tsx'), 'utf8')),
    glyphs: statusGlyphs(readFileSync(join(renderer, 'icons.tsx'), 'utf8')),
    badges: wallBadges(readFileSync(join(renderer, 'components', 'WallMascot.tsx'), 'utf8')),
  };
  const template = readFileSync(join(repo, 'scripts', 'design-system', 'page.html'), 'utf8');
  return new Map([
    ['design-system.html', renderPage(template, { t, marks, rules: r })],
    ['design-system.md', markdown(doc, t)],
    ['design-system.json', `${JSON.stringify(json(t, r), null, 2)}\n`],
    ['ds/tokens.css', tokensCss(css)],
  ]);
}

export function writeDesignSystem(site) {
  const files = build();
  for (const [name, body] of files) {
    mkdirSync(dirname(join(site, name)), { recursive: true });
    writeFileSync(join(site, name), body);
  }
  return `design system: ${[...files.keys()].join(', ')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(writeDesignSystem(join(repo, 'apps', 'website')));
}
