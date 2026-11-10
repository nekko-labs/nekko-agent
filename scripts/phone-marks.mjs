#!/usr/bin/env node
// Copies the desktop's provider marks, PR status glyphs and connector marks into the
// phones' assets, so the chat rows and the Connectors page draw what the desktop draws:
//   - provider marks (Lobe Icons, public/providers/*.svg): iOS ProviderMarks + Android provider_*.xml
//   - PR status glyphs (Gentleface line, gentleface-icons.tsx): iOS PrIcons + Android pr_*.xml
//   - connector marks (connectorIcons.tsx): iOS ConnectorMarks (Android has no Connectors page yet)
//   - theme icons (theme-icons.tsx line art, plus phone-theme-icons.json for the rows only
//     the phones list): iOS ThemeIcons + Android theme_*.xml
// The desktop stays the only place the drawings live. Run it after changing one:
//   node scripts/phone-marks.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const iosAssets = 'apps/ios/App/Assets.xcassets';
export const androidDrawables = 'apps/android/app/src/main/res/drawable';

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio', 'vllm'];
export const PR_GLYPHS = { 'git-pull-request': 'pr-open', 'git-pull-request-draft': 'pr-draft', 'git-merge': 'pr-merged', 'git-pull-request-closed': 'pr-closed' };
/** Phone connector kinds (PhoneConnectors.kinds) and how each is drawn. */
export const CONNECTORS = {
  github: 'ink', linear: 'ink',
  gitlab: 'full', todoist: 'full', trello: 'full',
  jira: 'brand', asana: 'brand', clickup: 'brand', floop: 'brand',
  bitbucket: 'bitbucket',
};
/** Theme icons from the desktop's picker (theme-icons.tsx). */
export const DESKTOP_THEME_ICONS = ['cat', 'galaxy', 'terminal', 'mountain', 'flame', 'tree-evergreen', 'blueberry', 'wizard-hat', 'beanie'];
/** Theme icons only the phones list (phone-theme-icons.json): mode rows, extra presets and families. */
export const PHONE_THEME_ICONS = Object.keys(JSON.parse(readFileSync(new URL('./phone-theme-icons.json', import.meta.url), 'utf8')).icons);
// Not on the desktop yet: Simple Icons' bitbucket path (CC0), in Atlassian blue.
const BITBUCKET = 'M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z';

const read = (p) => readFileSync(join(root, p), 'utf8');
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const FOLDER = '{"info":{"author":"xcode","version":1}}\n';

function svgPaths(svg) {
  return [...svg.matchAll(/<path([^>]*?)\/?>(?:<\/path>)?/g)].map((m) => ({
    d: /\sd="([^"]+)"/.exec(m[1])[1],
    opacity: Number(/fill-opacity="([^"]+)"/.exec(m[1])?.[1] ?? 1),
  }));
}

function imageset(out, folder, name, svg, template) {
  const dir = `${iosAssets}/${folder}/${name}.imageset`;
  out[`${dir}/${name}.svg`] = `${svg}\n`;
  out[`${dir}/Contents.json`] = json({
    images: [{ filename: `${name}.svg`, idiom: 'universal' }],
    info: { author: 'xcode', version: 1 },
    properties: { 'preserves-vector-representation': true, 'template-rendering-intent': template ? 'template' : 'original' },
  });
}

function drawable(out, name, viewport, paths, comment) {
  const body = paths.map((p) => p.stroke ? [
    '    <path',
    '        android:fillColor="#00000000"',
    '        android:strokeColor="#FF000000"',
    `        android:strokeWidth="${p.stroke}"`,
    '        android:strokeLineCap="round"',
    '        android:strokeLineJoin="round"',
    `        android:pathData="${p.d}" />`,
  ].join('\n') : [
    '    <path',
    '        android:fillColor="#FF000000"',
    ...(p.opacity < 1 ? [`        android:fillAlpha="${p.opacity}"`] : []),
    ...(p.evenOdd ? ['        android:fillType="evenOdd"'] : []),
    `        android:pathData="${p.d}" />`,
  ].join('\n')).join('\n');
  out[`${androidDrawables}/${name}.xml`] = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
${body}
</vector>
`;
}

/** A <rect> or <circle> as path data, for assets that keep to plain paths. */
function shapePath(el, scale = 1) {
  const a = (k) => Math.round(Number(new RegExp(`\\s${k}="([^"]+)"`).exec(el)?.[1] ?? 0) * scale * 1000) / 1000;
  if (el.startsWith('<circle')) {
    const [cx, cy, r] = [a('cx'), a('cy'), a('r')];
    return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
  }
  const [x, y, w, h, r] = [a('x'), a('y'), a('width'), a('height'), a('rx')];
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** Scales every number in path data without arcs (IconOven's 24 grid onto our 16). */
function scalePath(d, k) {
  if (/[aA]/.test(d)) throw new Error('scalePath: arcs are not handled');
  // Compact data runs numbers together (".56-1.06.88.1"); keep a space where one number follows another.
  let out = '';
  for (const [, cmd, n] of d.matchAll(/([a-zA-Z])|(-?(?:\d*\.\d+|\d+))/g)) {
    if (cmd) { out += cmd; continue; }
    const v = String(Math.round(Number(n) * k * 1000) / 1000);
    out += /[\d.]$/.test(out) && !v.startsWith('-') ? ` ${v}` : v;
  }
  return out;
}

/**
 * Each theme icon's line art as paths: filled outlines (Gentleface) or 1px round
 * strokes on the 16 grid (the wizard hat, beanie and blueberry).
 */
function themeIconPaths() {
  const ti = read('apps/desktop/src/renderer/theme-icons.tsx');
  const konst = (name) => new RegExp(`\\nconst ${name} = '([^']+)';`).exec(ti)[1];
  const path = (d, scale = 1) => (konst(d).startsWith('<') ? shapePath(konst(d), scale) : scale === 1 ? konst(d) : scalePath(konst(d), scale));
  const icons = {};
  for (const name of DESKTOP_THEME_ICONS.slice(0, 6)) {
    const line = new RegExp(`\\n  "${name}": \\{\\r?\\n    line: "(.*?)",\\r?\\n`).exec(ti)[1].replace(/\\"/g, '"');
    icons[name] = [{ d: /d="([^"]+)"/.exec(line)[1], opacity: 1 }];
  }
  const k = 2 / 3;
  icons['wizard-hat'] = ['WIZ_CONE', 'WIZ_BAND', 'WIZ_STAR'].map((n) => ({ d: path(n, k), stroke: 1 }));
  icons.beanie = ['BEANIE_CROWN', 'BEANIE_BRIM', 'BEANIE_FLAKE', 'BEANIE_RIBS'].map((n) => ({ d: path(n), stroke: 1 }));
  icons.blueberry = ['BERRY_BACK_ARC', 'BERRY_FRONT', 'BERRY_CROWNS'].map((n) => ({ d: path(n), stroke: 1 }));
  const extra = JSON.parse(read('scripts/phone-theme-icons.json')).icons;
  for (const name of PHONE_THEME_ICONS) icons[name] = [{ d: extra[name], opacity: 1 }];
  return icons;
}

const THEME_ICON_SOURCE = {
  'wizard-hat': 'IconOven Stroke wizard-hat (MIT, res/raw/license_iconoven_mit.txt), scaled from its 24 grid',
  beanie: "Nekko Agent's own knitted cat-ear beanie",
  blueberry: "Nekko Agent's own blueberries",
};

/** Every generated file, by its path from the repository root. */
export function generate() {
  const out = {};

  out[`${iosAssets}/ProviderMarks/Contents.json`] = FOLDER;
  for (const p of PROVIDERS) {
    const svg = read(`apps/desktop/src/renderer/public/providers/${p}.svg`);
    const evenOdd = /fill-rule="evenodd"/.test(svg);
    const paths = svgPaths(svg);
    const inner = paths.map((x) => `<path${evenOdd ? ' fill-rule="evenodd"' : ''}${x.opacity < 1 ? ` fill-opacity="${x.opacity}"` : ''} fill="#000000" d="${x.d}"/>`).join('');
    imageset(out, 'ProviderMarks', `provider-${p}`, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${inner}</svg>`, true);
    drawable(out, `provider_${p}`, 24, paths.map((x) => ({ ...x, evenOdd })),
      `${p} mark from Lobe Icons (MIT), as the desktop's public/providers/${p}.svg. Tinted by the row. Generated by scripts/phone-marks.mjs.`);
  }

  const gf = read('apps/desktop/src/renderer/gentleface-icons.tsx');
  out[`${iosAssets}/PrIcons/Contents.json`] = FOLDER;
  for (const [glyph, name] of Object.entries(PR_GLYPHS)) {
    const line = new RegExp(`'${glyph}': \\{ line: "(.*?)", solid:`).exec(gf)[1].replace(/\\"/g, '"');
    const d = /d="([^"]+)"/.exec(line)[1];
    imageset(out, 'PrIcons', name, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#000000" d="${d}"/></svg>`, true);
    drawable(out, name.replace('-', '_'), 16, [{ d, opacity: 1 }],
      `Gentleface 0.3.0 ${glyph} (line-round, 16px), MIT, as the desktop's SessionPrChip. Tinted by the PR's state. Generated by scripts/phone-marks.mjs.`);
  }

  const ci = read('apps/desktop/src/renderer/connectorIcons.tsx');
  const brand = (kind) => {
    const m = new RegExp(`\\n  ${kind}: \\{\\n    color: '([^']+)',\\n(?:    fillRule: '(evenodd)',\\n)?    path: '([^']+)'`).exec(ci);
    return { color: m[1], evenOdd: !!m[2], d: m[3] };
  };
  const full = (kind) => {
    const start = ci.indexOf(`\n  ${kind}: {\n    viewBox:`, ci.indexOf('const FULL_COLOUR'));
    const block = ci.slice(start, ci.indexOf('\n  },', start));
    return {
      viewBox: /viewBox: '([^']+)'/.exec(block)[1],
      body: block.slice(block.indexOf('<>') + 2, block.lastIndexOf('</>')).trim().replace(/\s*\/>/g, '/>').replace(/\n\s*/g, ''),
    };
  };
  const square = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${viewBox}">${body}</svg>`;
  out[`${iosAssets}/ConnectorMarks/Contents.json`] = FOLDER;
  for (const [kind, how] of Object.entries(CONNECTORS)) {
    const name = `connector-${kind}`;
    if (how === 'full') {
      const f = full(kind);
      // Asset-catalog SVGs keep to plain fills: Trello's top-to-bottom gradient becomes its darker stop.
      const body = f.body.replace(/<defs>.*?<\/defs>/, '').replace(/fill=\{`url\(#\$\{g\}a\)`\}/, 'fill="#0079BF"');
      if (body.includes('url(')) throw new Error(`${kind}: a gradient is left in the phone's mark`);
      imageset(out, 'ConnectorMarks', name, square(f.viewBox, body), false);
    } else {
      const b = how === 'bitbucket' ? { color: '#0052CC', evenOdd: false, d: BITBUCKET } : brand(kind);
      const fill = how === 'ink' ? '#000000' : b.color;
      imageset(out, 'ConnectorMarks', name, square('0 0 24 24', `<path${b.evenOdd ? ' fill-rule="evenodd"' : ''} fill="${fill}" d="${b.d}"/>`), how === 'ink');
    }
  }
  out[`${iosAssets}/ThemeIcons/Contents.json`] = FOLDER;
  for (const [icon, paths] of Object.entries(themeIconPaths())) {
    const svgPath = (p) => p.stroke
      ? `<path fill="none" stroke="#000000" stroke-width="${p.stroke}" stroke-linecap="round" stroke-linejoin="round" d="${p.d}"/>`
      : `<path fill="#000000" d="${p.d}"/>`;
    imageset(out, 'ThemeIcons', `theme-${icon}`, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${paths.map(svgPath).join('')}</svg>`, true);
    drawable(out, `theme_${icon.replace(/-/g, '_')}`, 16, paths,
      `${THEME_ICON_SOURCE[icon] ?? `Gentleface 0.6.0 ${icon} (line-round, 16px), MIT`}, as the desktop's theme picker (theme-icons.tsx). Tinted by the theme. Generated by scripts/phone-marks.mjs.`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [path, text] of Object.entries(generate())) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
