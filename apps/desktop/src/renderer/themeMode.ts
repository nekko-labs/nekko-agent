import { currentPresetAccent, findThemePreset, resolveThemePreset, themePresetOf } from '@nekko-agent/shared';
import type { AppSettings, ThemePreset } from '@nekko-agent/shared';

type Mode = 'light' | 'dark';
type Settings = Pick<Partial<AppSettings>, 'theme' | 'themePreset' | 'accent' | 'accent2'>;
// Dark palettes inherit the core light surfaces; their accents need enough depth
// to remain readable there. No extra persisted IDs or parallel surface system.
const LIGHT_ACCENTS: Record<string, readonly [string, string]> = {
  nebula: ['#6652a3', '#a13d76'], terminal: ['#23713d', '#526b1b'],
  nord: ['#326878', '#486581'], ember: ['#b34a05', '#be3030'],
  autumn: ['#a14b09', '#806000'],
};

function variant(id: string | undefined, mode: Mode): string | undefined {
  if (id === 'system') return resolveThemePreset(id, mode === 'dark');
  const preset = findThemePreset(id);
  if (preset?.mode === mode) return id;
  if (preset?.family) {
    const pair = `x-${preset.family}-${mode === 'dark' ? 'dark' : 'white'}`;
    if (findThemePreset(pair)) return pair;
  }
  if (id === 'light' || id === 'dark') return mode;
  return id;
}

function defaults(id: string | undefined, mode: Mode) {
  const preset = findThemePreset(id);
  const colors = mode === 'light' && id ? LIGHT_ACCENTS[id] : undefined;
  return { preset, accent: colors?.[0] ?? preset?.accent ?? findThemePreset(mode)!.accent,
    accent2: colors?.[1] ?? preset?.accent2 ?? findThemePreset(mode)!.accent2 };
}

/** Resolve mode and palette independently, including settings from older versions. */
export function resolveThemeAppearance(settings: Settings | null | undefined, prefersDark: boolean) {
  const picked = themePresetOf(settings);
  const mode: Mode = !settings?.theme || settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.theme;
  const presetId = variant(picked, mode);
  const colors = defaults(presetId, mode);
  const original = findThemePreset(picked);
  const channel = (key: 'accent' | 'accent2') => {
    const saved = currentPresetAccent(picked, settings?.[key]);
    // Shipped values follow the mode; a custom value belongs to the user.
    return !saved || saved.toLowerCase() === original?.[key].toLowerCase() ? colors[key] : saved;
  };
  return { mode, presetId, preset: colors.preset, accent: channel('accent'), accent2: channel('accent2') };
}

/** Palette selection keeps the current mode and intentionally resets custom colors. */
export function themePalettePatch(settings: Settings, id: string, prefersDark: boolean): Partial<AppSettings> {
  const { mode } = resolveThemeAppearance(settings, prefersDark);
  const presetId = variant(id, mode);
  const colors = defaults(presetId, mode);
  return { theme: mode, themePreset: presetId, accent: colors.accent, accent2: colors.accent2 };
}

/** A mode change keeps both the palette and each individually customized channel. */
export function themeModePatch(settings: Settings, mode: Mode, prefersDark: boolean): Partial<AppSettings> {
  const before = resolveThemeAppearance(settings, prefersDark);
  const presetId = variant(before.presetId, mode);
  const from = defaults(before.presetId, before.mode);
  const to = defaults(presetId, mode);
  return { theme: mode, themePreset: presetId,
    accent: before.accent.toLowerCase() === from.accent.toLowerCase() ? to.accent : before.accent,
    accent2: before.accent2.toLowerCase() === from.accent2.toLowerCase() ? to.accent2 : before.accent2 };
}

/** Swatches and reset colors use the same mode-aware defaults as the renderer. */
export function themePaletteDefaults(preset: ThemePreset, mode: Mode) {
  const id = variant(preset.id, mode);
  return { ...defaults(id, mode), id };
}
