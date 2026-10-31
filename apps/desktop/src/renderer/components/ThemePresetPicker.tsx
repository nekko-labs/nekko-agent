import React, { useState } from 'react';
import type { AppSettings, ThemePreset } from '@nekko-agent/shared';
import { THEME_PRESETS, currentPresetAccent, experimentalFamilies, findThemePreset, themePresetOf } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { ColorWheel } from './ColorWheel.js';

/** Preset groups, so light and dark looks sit under their own headings. Experimental sits above Fun!. */
const GROUPS: Array<{ mode: ThemePreset['mode']; titleKey: string; fun?: boolean; experimental?: boolean }> = [
  { mode: 'system', titleKey: 'settings.themeAuto' },
  { mode: 'light', titleKey: 'settings.themeLight' },
  { mode: 'dark', titleKey: 'settings.themeDark' },
  { mode: 'light', titleKey: 'Experimental', experimental: true },
  { mode: 'dark', titleKey: 'Fun!', fun: true },
];

const FAMILIES = experimentalFamilies();

/** Hard stops show the actual palette colors without blended intermediate shades. */
export function slicedSwatch(colors: readonly string[]): string {
  return `conic-gradient(from 0deg, ${colors.map((color, i) => `${color} ${i * 100 / colors.length}% ${(i + 1) * 100 / colors.length}%`).join(', ')})`;
}

const WHEEL_SWATCH = slicedSwatch(['#f87171', '#fbbf24', '#4ade80', '#22d3ee', '#818cf8', '#e879f9']);

/**
 * Grouped preset grid plus a color wheel, shared by Settings → Appearance and
 * the onboarding theme step. Selecting a preset writes theme + themePreset +
 * accent + accent2 in one patch; the caller's `update` persists and applies it,
 * so a click previews live.
 *
 * The wheel edits `accent`/`accent2` on top of whichever preset is selected:
 * the preset keeps owning the surface tokens, the wheel owns the brand colors.
 */
export function ThemePresetPicker({
  settings,
  update,
  showLabel = true,
  large = false,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  /** The "Theme" label the Settings row shows; the wizard supplies its own heading. */
  showLabel?: boolean;
  /** Roomier swatches for the onboarding step. */
  large?: boolean;
}) {
  const tr = useT();
  // Only highlight a preset when it was explicitly selected. Falling back to
  // `settings.theme` would falsely highlight a preset when the user only has a
  // base mode and a custom accent. Nothing saved yet is System.
  const activeId = themePresetOf(settings);
  const activePreset = findThemePreset(activeId);
  const accent = currentPresetAccent(activeId, settings.accent) ?? activePreset?.accent;
  // With no preset and no saved secondary, fall back to the base brand cyan the
  // stylesheet ships, so the gradient preview reads as a gradient and not a slab.
  const accent2 = currentPresetAccent(activeId, settings.accent2) ?? activePreset?.accent2 ?? findThemePreset('system')?.accent2 ?? accent;
  // "Custom" means the colors no longer match what the selected preset ships.
  const customized =
    !!activePreset && (accent !== activePreset.accent || accent2 !== activePreset.accent2);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<'accent' | 'accent2'>('accent');
  // Experimental families show one tile each; the open family lists its versions.
  const [openFamily, setOpenFamily] = useState<string | undefined>(activePreset?.family);

  const select = (preset: ThemePreset) => {
    void update({
      theme: preset.mode,
      themePreset: preset.id,
      accent: preset.accent,
      accent2: preset.accent2,
    });
  };

  const setColor = (hex: string) => void update(editing === 'accent' ? { accent: hex } : { accent2: hex });

  const resetColors = () => {
    if (!activePreset) return;
    void update({ accent: activePreset.accent, accent2: activePreset.accent2 });
  };

  return (
    <div className={showLabel ? 'mt-4' : undefined}>
      {showLabel && <span className="text-sm">{tr('settings.theme')}</span>}

      <div className={showLabel ? 'mt-2 space-y-3' : 'space-y-3'}>
        {GROUPS.map((group) => {
          if (group.experimental) return FAMILIES.length ? (
            <div key="experimental">
              <span className="text-2xs font-medium tracking-wide text-ink-faint uppercase">Experimental</span>
              <div className="mt-1.5 grid grid-cols-4 gap-2" role="group" aria-label="Experimental">
                {FAMILIES.map((family) => {
                  const active = family.presets.some((p) => p.id === activeId);
                  const open = openFamily === family.id;
                  const first = family.presets[0];
                  return (
                    <button
                      key={family.id}
                      onClick={() => setOpenFamily(open ? undefined : family.id)}
                      title={`${family.label}: ${family.presets.map((p) => p.label).join(', ')}`}
                      aria-expanded={open}
                      aria-controls={`theme-family-${family.id}`}
                      data-theme-family={family.id}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-2xs font-medium transition-colors ${
                        active ? 'border-accent bg-accent-soft' : open ? 'border-ink-faint bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <span
                        className={`${large ? 'h-14 w-14' : 'h-10 w-10'} rounded-full border border-line`}
                        style={{ background: slicedSwatch([first.accent, first.paper ?? first.accent2, ...family.presets.slice(1).map((p) => p.paper ?? p.accent)]) }}
                      />
                      <span className={active ? 'text-accent' : 'text-ink-soft'}>
                        {family.label} <span aria-hidden className="text-ink-faint">{open ? '▴' : '▾'}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {FAMILIES.filter((f) => f.id === openFamily).map((family) => (
                <div key={family.id} id={`theme-family-${family.id}`} className="mt-2 rounded-xl border border-line bg-surface-2 p-2">
                  <span className="text-2xs text-ink-faint">{family.label} versions</span>
                  <div className={`mt-1.5 grid gap-2 ${family.presets.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={`${family.label} versions`}>
                    {family.presets.map((preset) => {
                      const active = activeId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => select(preset)}
                          title={`${family.label} ${preset.label}`}
                          role="radio"
                          aria-checked={active}
                          className={`flex items-center gap-2 rounded-lg border p-2 text-2xs font-medium transition-colors ${
                            active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                          }`}
                        >
                          <span className="h-7 w-7 shrink-0 rounded-full border border-line" style={{ background: slicedSwatch(preset.swatch) }} />
                          <span className={active ? 'text-accent' : 'text-ink-soft'}>{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null;
          const presets = THEME_PRESETS.filter((p) => p.group !== 'experimental' && (group.fun ? p.id === 'autumn' : p.mode === group.mode && p.id !== 'autumn'));
          if (presets.length === 0) return null;
          return (
            <div key={group.titleKey}>
              <span className="text-2xs font-medium tracking-wide text-ink-faint uppercase">
                {group.fun ? 'Fun!' : tr(group.titleKey)}
              </span>
              <div className="mt-1.5 grid grid-cols-4 gap-2" role="radiogroup" aria-label={group.fun ? 'Fun!' : tr(group.titleKey)}>
                {presets.map((preset) => {
                  const active = activeId === preset.id;
                  const gradient = slicedSwatch(preset.swatch);
                  return (
                    <button
                      key={preset.id}
                      onClick={() => select(preset)}
                      title={preset.label}
                      role="radio"
                      aria-checked={active}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-2xs font-medium transition-colors ${
                        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <span
                        className={`${large ? 'h-14 w-14' : 'h-10 w-10'} rounded-full border border-line`}
                        style={{ background: gradient }}
                      />
                      <span className={active ? 'text-accent' : 'text-ink-soft'}>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom colors: the wheel rides on top of the selected preset. */}
      <div className="mt-3 rounded-xl border border-line bg-surface">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 p-2.5 text-left"
        >
          <span
            className="h-8 w-8 shrink-0 rounded-full border border-line"
            style={{ background: WHEEL_SWATCH }}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">{tr('settings.customColors')}</span>
            <span className="block truncate text-2xs text-ink-faint">
              {customized ? tr('settings.customColorsOn') : tr('settings.customColorsHint')}
            </span>
          </span>
          <span
            aria-hidden
            className="h-5 w-10 shrink-0 rounded-full border border-line"
            style={{ background: `linear-gradient(135deg, ${accent}, ${accent2})` }}
          />
          <span aria-hidden className="text-2xs text-ink-faint">
            {open ? '▲' : '▼'}
          </span>
        </button>

        {open && (
          <div className="flex flex-wrap items-start gap-4 border-t border-line p-3">
            <ColorWheel
              value={editing === 'accent' ? accent : accent2}
              onChange={setColor}
              label={editing === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
            />
            <div className="min-w-[150px] flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={tr('settings.customColors')}>
                {(['accent', 'accent2'] as const).map((which) => {
                  const on = editing === which;
                  return (
                    <button
                      key={which}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setEditing(which)}
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-2xs font-medium transition-colors ${
                        on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'
                      }`}
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full border border-line"
                        style={{ background: which === 'accent' ? accent : accent2 }}
                      />
                      <span className="truncate">
                        {which === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <input
                  className="input py-1 font-mono text-xs"
                  aria-label={editing === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
                  value={editing === 'accent' ? accent : accent2}
                  onChange={(e) => {
                    const next = e.target.value.trim();
                    // Let the field hold a half-typed hex; only commit a complete one.
                    if (/^#[0-9a-fA-F]{6}$/.test(next)) setColor(next.toLowerCase());
                  }}
                  spellCheck={false}
                />
                {/* The OS picker, for eyedroppers and exact values the wheel can't hit. */}
                <input
                  type="color"
                  className="h-7 w-9 shrink-0 rounded-lg"
                  aria-label={tr('settings.systemPicker')}
                  value={editing === 'accent' ? accent : accent2}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
              <button
                className="text-2xs text-accent hover:underline disabled:text-ink-faint disabled:no-underline"
                onClick={resetColors}
                disabled={!customized}
              >
                {tr('settings.resetColors')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
