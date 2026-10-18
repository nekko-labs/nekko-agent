import type { ThemeMode } from './settings.js';

/**
 * A named theme preset. Presets combine a light/dark/system mode with a paired
 * accent + secondary accent and a small palette of swatch colors used to draw
 * the gradient circle in the theme picker.
 *
 * Some presets also carry surface/ink overrides for when the accent alone
 * cannot produce the intended atmosphere (e.g. a green-tinted terminal look or
 * a warm solar paper).
 */
export interface ThemePreset {
  /** Machine id used for `settings.themePreset` and `[data-preset]`. */
  id: string;
  /** Base mode the preset resolves to. */
  mode: ThemeMode;
  /** Primary accent color (6-digit hex). */
  accent: string;
  /** Secondary accent color used for the brand gradient (6-digit hex). */
  accent2: string;
  /** 3-4 key colors drawn as a conic gradient in the swatch circle. */
  swatch: string[];
  /** Human-readable label shown in the picker. */
  label: string;
  /** Optional tinted surface/ink tokens for presets that need deeper changes. */
  paper?: string;
  surface?: string;
  surface2?: string;
  ink?: string;
  inkSoft?: string;
  inkFaint?: string;
  line?: string;
}

/** v1 theme preset catalog. Names and palettes are intentionally adjustable. */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'system',
    mode: 'system',
    accent: '#6d5efc',
    accent2: '#06b6d4',
    swatch: ['#6d5efc', '#06b6d4', '#8b7dff', '#22d3ee'],
    label: 'System',
  },
  {
    id: 'light',
    mode: 'light',
    accent: '#6d5efc',
    accent2: '#06b6d4',
    swatch: ['#6d5efc', '#06b6d4', '#f2f2f7'],
    label: 'Light',
  },
  {
    id: 'dark',
    mode: 'dark',
    accent: '#8b7dff',
    accent2: '#22d3ee',
    swatch: ['#8b7dff', '#22d3ee', '#16161c'],
    label: 'Dark',
  },
  {
    id: 'nebula',
    mode: 'dark',
    // Toned down from violet-400/pink-400: same hues, less glare on dark paper.
    accent: '#9d8ce6',
    accent2: '#d98bb6',
    swatch: ['#9d8ce6', '#d98bb6', '#15131f', '#2a2540'],
    label: 'Nebula',
    paper: '#0b0a12',
    surface: '#15131f',
    surface2: '#1e1b2b',
    ink: '#ece9f5',
    inkSoft: '#a7a1bb',
    inkFaint: '#6f6a84',
    line: '#262334',
  },
  {
    id: 'terminal',
    mode: 'dark',
    accent: '#3fb96a',
    accent2: '#8fbf3a',
    swatch: ['#3fb96a', '#8fbf3a', '#0a100a'],
    label: 'Terminal',
    paper: '#080a08',
    surface: '#111711',
    surface2: '#192019',
    ink: '#e8f5e8',
    inkSoft: '#8fab8f',
    inkFaint: '#576b57',
    line: '#1f281f',
  },
  {
    id: 'nord',
    mode: 'dark',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    swatch: ['#88c0d0', '#81a1c1', '#2e3440'],
    label: 'Nord',
    paper: '#1e222a',
    surface: '#252a33',
    surface2: '#2e3440',
    ink: '#eceff4',
    inkSoft: '#9ca6b6',
    inkFaint: '#6b7787',
    line: '#3b4252',
  },
  {
    id: 'solar',
    mode: 'light',
    accent: '#b45309',
    accent2: '#d97706',
    swatch: ['#b45309', '#d97706', '#faf6ed'],
    label: 'Solar',
    paper: '#faf6ed',
    surface: '#fffdf6',
    surface2: '#f3ead9',
    ink: '#2b211a',
    inkSoft: '#6d5d4d',
    inkFaint: '#9e8d7a',
    line: '#e8dfc8',
  },
  {
    // The marketing site's white look: lavender paper and the logo's indigo-to-lavender gradient.
    id: 'lilac',
    mode: 'light',
    accent: '#5b4ea7',
    accent2: '#9d8ce6',
    swatch: ['#453a92', '#9d8ce6', '#fbfaff', '#f1edff'],
    label: 'Lilac',
    paper: '#fbfaff',
    surface: '#ffffff',
    surface2: '#f1edff',
    ink: '#17151f',
    inkSoft: '#5d5970',
    inkFaint: '#8f8aa3',
    line: '#e6e1f5',
  },
  {
    // The marketing site's colourful look: a lavender (#9D8CE6) ground, dark ink, frosted white panels.
    id: 'lavender',
    mode: 'light',
    accent: '#3b2f86',
    accent2: '#5b4ea7',
    swatch: ['#9d8ce6', '#3b2f86', '#e4dff8', '#8ae4f2'],
    label: 'Lavender',
    paper: '#9d8ce6',
    surface: '#e4dff8',
    surface2: '#d9d2f5',
    ink: '#17151f',
    inkSoft: '#2c2640',
    inkFaint: '#4a4366',
    line: '#c4b8ee',
  },
  {
    id: 'ember',
    mode: 'dark',
    accent: '#f97316',
    accent2: '#ef4444',
    swatch: ['#f97316', '#ef4444', '#0c0c11'],
    label: 'Ember',
  },
  {
    id: 'autumn',
    mode: 'dark',
    accent: '#fb923c',
    accent2: '#eab308',
    swatch: ['#fb923c', '#eab308', '#0c0c11'],
    label: 'Spooky',
  },
];

/**
 * Accent colors a preset used to ship. Choosing a preset saves its accents into
 * settings, so a retuned preset would otherwise never reach anyone who picked
 * it before. A saved value equal to a retired one is read as the current one;
 * any other value is the user's own choice and is left alone.
 */
const RETIRED_PRESET_ACCENTS: Record<string, Record<string, string>> = {
  nebula: { '#a78bfa': '#9d8ce6', '#f472b6': '#d98bb6' },
  terminal: { '#22c55e': '#3fb96a', '#84cc16': '#8fbf3a' },
};

/** A saved accent, upgraded if it is a color the preset no longer ships. */
export function currentPresetAccent(presetId: string | undefined, saved: string): string;
export function currentPresetAccent(presetId: string | undefined, saved: string | undefined): string | undefined;
export function currentPresetAccent(presetId: string | undefined, saved: string | undefined): string | undefined {
  if (!presetId || !saved) return saved;
  return RETIRED_PRESET_ACCENTS[presetId]?.[saved.toLowerCase()] ?? saved;
}

/** Look up a preset by id. */
export function findThemePreset(id: string | undefined): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

/** The settings a paired phone mirrors to look like the desktop. Nothing secret. */
export interface Appearance {
  theme: ThemeMode;
  themePreset?: string;
  accent?: string;
  accent2?: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const PRESET_ID = /^[a-z0-9-]{1,32}$/;

/**
 * The public look of `settings`, built field by field so nothing else in the
 * settings can ride along to the relay: the mode (anything unknown reads as
 * `system`), the preset id when it looks like one (`[a-z0-9-]{1,32}`; the phone ignores ids it does not know), and the accents as
 * lowercase 6-digit hex (anything else is dropped). The daemon builds the same
 * object (`crates/nekkod/src/settings.rs`, `appearance_of`).
 */
export function appearanceOf(settings: { theme?: unknown; themePreset?: unknown; accent?: unknown; accent2?: unknown } | null | undefined): Appearance {
  const theme: ThemeMode = settings?.theme === 'light' || settings?.theme === 'dark' ? settings.theme : 'system';
  const out: Appearance = { theme };
  const preset = settings?.themePreset;
  if (typeof preset === 'string' && PRESET_ID.test(preset)) out.themePreset = preset;
  for (const k of ['accent', 'accent2'] as const) {
    const v = settings?.[k];
    if (typeof v === 'string' && HEX.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

/** Whether a settings patch can change `appearanceOf` (a reset is `null`). */
export function touchesAppearance(patch: unknown): boolean {
  if (patch === null || patch === undefined) return true;
  if (typeof patch !== 'object') return false;
  return ['theme', 'themePreset', 'accent', 'accent2'].some((k) => k in (patch as object));
}
