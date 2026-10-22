import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@nekko-agent/shared';
import { composite, contrastRatio, parseColor } from './contrast.js';
import { rules, stylesheet } from './tests/css.js';

/**
 * The merged-PR banner put fixed light-violet text on a gradient that is
 * transparent on its left, so in light mode the repository label sat on
 * near-white paper at 1.15:1. These checks read the shipped theme tokens out
 * of styles.css and hold every piece of merged text to WCAG AA (4.5:1) on the
 * darkest and lightest parts of what it sits on, in every theme and preset.
 */

const css = stylesheet('styles.css');

/** The custom properties declared directly in the first block for `selector` (raw values, as parseColor reads them). */
function block(selector: string): Record<string, string> {
  const rule = rules(css, selector)[0];
  if (!rule) throw new Error(`No ${selector} block in styles.css`);
  const vars: Record<string, string> = {};
  rule.each((node) => { if (node.type === 'decl' && node.prop.startsWith('--')) vars[node.prop] = node.value.trim(); });
  return vars;
}

const light = block(':root');
const dark = { ...light, ...block("[data-theme='dark']") };
const THEMES: Record<string, Record<string, string>> = {
  light,
  'light/solar': { ...light, ...block("[data-theme='light'][data-preset='solar']") },
  'light/lilac': { ...light, ...block("[data-theme='light'][data-preset='lilac']") },
  'light/lavender': { ...light, ...block("[data-theme='light'][data-preset='lavender']") },
  dark,
  'dark/nebula': { ...dark, ...block("[data-theme='dark'][data-preset='nebula']") },
  'dark/terminal': { ...dark, ...block("[data-theme='dark'][data-preset='terminal']") },
  'dark/nord': { ...dark, ...block("[data-theme='dark'][data-preset='nord']") },
};
// Every Experimental preset, on top of its base mode.
const EXPERIMENTAL = THEME_PRESETS.filter((p) => p.group === 'experimental');
for (const p of EXPERIMENTAL) {
  THEMES[`${p.mode}/${p.id}`] = { ...(p.mode === 'dark' ? dark : light), ...block(`[data-theme='${p.mode}'][data-preset='${p.id}']`) };
}

const AA = 4.5;

describe('tinted dark presets', () => {
  // Chat windows, the wall composer and the dock paint --win. A tinted preset
  // that leaves it at the neutral dark value shows grey windows on a purple or
  // green field, which is the mismatch this guards against.
  it.each(['nebula', 'terminal', 'nord'])('%s sets its own window surface', (preset) => {
    const vars = block(`[data-theme='dark'][data-preset='${preset}']`);
    expect(vars['--win']).toBeDefined();
    expect(vars['--win']).not.toBe(dark['--win']);
  });
  it('ink stays readable on the window surface', () => {
    for (const [name, vars] of Object.entries(THEMES)) {
      const ratio = contrastRatio(parseColor(vars['--ink-soft']), parseColor(vars['--win']));
      expect(ratio, `${name}: ink-soft on win = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('contrast helper', () => {
  it('matches the WCAG reference points', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#fff'), parseColor('#fff'))).toBeCloseTo(1, 5);
    // The reported bug: violet-100 on light paper.
    expect(contrastRatio(parseColor('#ede9fe'), parseColor('#fbfbfd'))).toBeLessThan(1.2);
  });
  it('composites translucent colours over paper', () => {
    const half = composite(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#ffffff'));
    expect(Math.round(half.r)).toBe(128);
  });
});

/** sRGB `color-mix(in srgb, a p%, b)` for opaque colours, as styles.css uses it. */
function mix(a: string, p: number, b: string) {
  const [x, y] = [parseColor(a), parseColor(b)];
  const m = (u: number, v: number) => u * p + v * (1 - p);
  return { r: m(x.r, y.r), g: m(x.g, y.g), b: m(x.b, y.b), a: 1 };
}
const toHex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');

/** Each theme with the accent its preset applies (store.applyTheme). */
const ACCENTS: Record<string, string> = {
  light: '#6d5efc', 'light/solar': '#b45309', 'light/lilac': '#5b4ea7', 'light/lavender': '#3b2f86', dark: '#8b7dff',
  'dark/nebula': '#9d8ce6', 'dark/terminal': '#3fb96a', 'dark/nord': '#88c0d0',
  ...Object.fromEntries(EXPERIMENTAL.map((p) => [`${p.mode}/${p.id}`, p.accent])),
};

describe.each(EXPERIMENTAL.map((p) => [p.id, p] as const))('experimental preset %s', (_id, p) => {
  const vars = THEMES[`${p.mode}/${p.id}`];
  it('primary-button text is readable on the accent', () => {
    const ratio = contrastRatio(parseColor(vars['--on-accent']), parseColor(p.accent));
    expect(ratio, `on-accent on accent = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });
  it('sets its own window surface and paper', () => {
    expect(vars['--win']).toBeDefined();
    expect(vars['--paper']).toBe(p.paper);
  });
});

describe.each(Object.entries(THEMES))('artifact card colours in %s', (name, vars) => {
  const accent = ACCENTS[name];
  const surface = vars['--surface'];
  it('title and filename stay readable on the strongest (hover) wash', () => {
    const wash = mix(accent, 0.12, surface);
    for (const token of ['--ink', '--ink-soft']) {
      const ratio = contrastRatio(parseColor(vars[token]), wash);
      expect(ratio, `${token} on artifact wash = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });
  it('the extension chip label is readable on the chip', () => {
    const ink = mix(accent, 0.55, vars['--ink']);
    const chip = mix(accent, 0.14, surface);
    const ratio = contrastRatio(ink, chip);
    expect(ratio, `chip ${toHex(ink)} on ${toHex(chip)} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });
});

describe.each(Object.entries(THEMES))('merged PR colours in %s', (_name, vars) => {
  const get = (name: string) => {
    const value = vars[name];
    if (!value) throw new Error(`${name} is not defined`);
    return parseColor(value);
  };
  const paper = get('--paper');
  const surface = get('--surface');
  // The banner gradient runs from transparent (bare paper) to the full wash.
  const bannerStops = { 'bare paper': paper, 'soft wash': composite(get('--merged-wash-soft'), paper), 'full wash': composite(get('--merged-wash'), paper) };

  it.each(['--ink', '--ink-soft', '--merged-ink'])('%s is readable across the whole banner', (token) => {
    for (const [stop, background] of Object.entries(bannerStops)) {
      const ratio = contrastRatio(get(token), background);
      expect(ratio, `${token} on ${stop} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the merged chip and link are readable', () => {
    for (const base of [paper, surface]) {
      expect(contrastRatio(get('--merged-ink'), composite(get('--merged-chip'), base))).toBeGreaterThanOrEqual(AA);
      expect(contrastRatio(get('--merged-ink'), base)).toBeGreaterThanOrEqual(AA);
    }
  });
});
