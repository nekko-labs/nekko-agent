import React, { useState } from 'react';
import type { AppSettings, ThemePreset } from '@nekko-agent/shared';
import { currentPresetAccent, experimentalFamilies, findThemePreset, resolveThemePreset, themePresetOf } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { ColorWheel } from './ColorWheel.js';

/** The main Nekko look: the plum pair, toggled between its light and dark versions. */
const NEKKO = { light: 'x-plum-white', dark: 'x-plum-dark' } as const;
/** The curated theme list, in picker order. Family entries offer Light and Dark only. */
const THEMES = ['nebula', 'terminal', 'nord', 'ember', 'forest', 'blueberry'] as const;
const SEASONAL = ['autumn'] as const;

type Entry = { kind: 'preset'; preset: ThemePreset } | { kind: 'family'; id: string; label: string; presets: ThemePreset[] };

/** A family's Light and Dark versions; the Colourful version is not offered. */
function familyEntry(id: string): Entry | undefined {
  const family = experimentalFamilies().find((f) => f.id === id);
  if (!family) return undefined;
  const presets = family.presets.filter((p) => !p.id.endsWith('-colour'));
  return { kind: 'family', id, label: family.label, presets };
}

function entryOf(id: string): Entry | undefined {
  const preset = findThemePreset(id);
  return preset ? { kind: 'preset', preset } : familyEntry(id);
}

const THEME_ENTRIES = THEMES.map(entryOf).filter((e): e is Entry => !!e);
const SEASONAL_ENTRIES = SEASONAL.map(entryOf).filter((e): e is Entry => !!e);

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
  const prefersDark = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const shownNekko = resolveThemePreset(activeId, prefersDark);
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
        {/* Light / Dark: the main Nekko plum look. */}
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface-2 p-1" role="radiogroup" aria-label="Nekko mode">
          {(['light', 'dark'] as const).map((mode) => {
            const preset = findThemePreset(NEKKO[mode]);
            if (!preset) return null;
            // System resolves to one of the Nekko looks, so show which one is in use.
            const on = shownNekko === preset.id;
            return (
              <button
                key={mode}
                role="radio"
                aria-checked={on}
                data-nekko-mode={mode}
                onClick={() => select(preset)}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  on ? 'bg-accent-soft text-accent shadow-sm' : 'text-ink-soft hover:bg-surface'
                }`}
              >
                <span aria-hidden>{mode === 'light' ? '☀' : '☾'}</span>
                {mode === 'light' ? tr('settings.themeLight') : tr('settings.themeDark')}
              </button>
            );
          })}
        </div>

        {([
          { key: 'themes', title: 'Themes', entries: THEME_ENTRIES },
          { key: 'seasonal', title: 'Seasonal', entries: SEASONAL_ENTRIES },
        ] as const).map((section) => (
          <div key={section.key}>
            <span className="text-xs font-medium text-ink-soft">{section.title}</span>
            <div className="mt-1 grid grid-cols-4 gap-2" role="radiogroup" aria-label={section.title}>
              {section.entries.map((entry) => {
                if (entry.kind === 'preset') {
                  const preset = entry.preset;
                  const active = activeId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => select(preset)}
                      title={preset.label}
                      role="radio"
                      aria-checked={active}
                      className={`flex flex-col items-center gap-2 rounded-xl border p-2 text-2xs font-medium transition-colors ${
                        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <span className={`${large ? 'h-14 w-14' : 'h-10 w-10'} rounded-full border border-line`} style={{ background: slicedSwatch(preset.swatch) }} />
                      <span className={active ? 'text-accent' : 'text-ink-soft'}>{preset.label}</span>
                    </button>
                  );
                }
                const active = entry.presets.some((p) => p.id === activeId);
                const open = openFamily === entry.id;
                const [first, ...rest] = entry.presets;
                return (
                  <button
                    key={entry.id}
                    onClick={() => setOpenFamily(open ? undefined : entry.id)}
                    title={entry.label}
                    aria-expanded={open}
                    aria-controls={`theme-family-${entry.id}`}
                    data-theme-family={entry.id}
                    className={`flex flex-col items-center gap-2 rounded-xl border p-2 text-2xs font-medium transition-colors ${
                      active ? 'border-accent bg-accent-soft' : open ? 'border-ink-faint bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'
                    }`}
                  >
                    <span
                      className={`${large ? 'h-14 w-14' : 'h-10 w-10'} rounded-full border border-line`}
                      style={{ background: slicedSwatch([first.accent, first.paper ?? first.accent2, ...rest.map((p) => p.paper ?? p.accent)]) }}
                    />
                    <span className={active ? 'text-accent' : 'text-ink-soft'}>
                      {entry.label} <span aria-hidden className="text-ink-faint">{open ? '▴' : '▾'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {section.entries.map((entry) => entry.kind === 'family' && openFamily === entry.id ? (
              <div key={entry.id} id={`theme-family-${entry.id}`} className="mt-2 rounded-xl border border-line bg-surface-2 p-2">
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={`${entry.label} versions`}>
                  {entry.presets.map((preset) => {
                    const active = activeId === preset.id;
                    const label = preset.mode === 'dark' ? tr('settings.themeDark') : tr('settings.themeLight');
                    return (
                      <button
                        key={preset.id}
                        onClick={() => select(preset)}
                        title={`${entry.label} ${label}`}
                        role="radio"
                        aria-checked={active}
                        className={`flex items-center gap-2 rounded-lg border p-2 text-2xs font-medium transition-colors ${
                          active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                        }`}
                      >
                        <span className="h-7 w-7 shrink-0 rounded-full border border-line" style={{ background: slicedSwatch(preset.swatch) }} />
                        <span className={active ? 'text-accent' : 'text-ink-soft'}>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null)}
          </div>
        ))}
      </div>

      {/* Custom colors: the wheel rides on top of the selected preset. */}
      <div className="mt-3 rounded-xl border border-line bg-surface">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 p-3 text-left"
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
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-2xs font-medium transition-colors ${
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
