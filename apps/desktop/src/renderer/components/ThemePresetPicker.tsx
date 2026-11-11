import React, { useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { findThemePreset } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { ChevronDownIcon, MoonIcon, SunIcon } from '../icons.js';
import { resolveThemeAppearance, themeModePatch, themePaletteDefaults, themePalettePatch } from '../themeMode.js';
import { THEME_ICON, ThemeIcon } from '../theme-icons.js';
import { ColorWheel } from './ColorWheel.js';
import './ThemePresetPicker.css';

const THEMES = [
  { id: 'x-plum-white', label: 'Nekko' }, { id: 'nebula', label: 'Nebula' },
  { id: 'terminal', label: 'Terminal' }, { id: 'nord', label: 'Nord' },
  { id: 'ember', label: 'Ember' }, { id: 'x-forest-white', label: 'Forest' },
  { id: 'x-blueberry-white', label: 'Blueberry' },
];
const SEASONAL = [{ id: 'autumn', label: 'Spooky' }, { id: 'winter', label: 'Winter' }];

/** Hard stops show the actual palette colors without blended intermediate shades. */
export function slicedSwatch(colors: readonly string[]): string {
  return `conic-gradient(from 0deg, ${colors.map((color, i) => `${color} ${i * 100 / colors.length}% ${(i + 1) * 100 / colors.length}%`).join(', ')})`;
}

const WHEEL_SWATCH = slicedSwatch(['#f87171', '#fbbf24', '#4ade80', '#22d3ee', '#818cf8', '#e879f9']);

/**
 * One icon per palette (a cat for Nekko, a blueberry for Blueberry, a wizard hat
 * for Spooky...), drawn in that palette's accent, plus a color wheel, shared by Settings → Appearance and
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
  const prefersDark = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const { mode, presetId: activeId, preset: activePreset, accent, accent2 } = resolveThemeAppearance(settings, prefersDark);
  const defaults = activePreset ? themePaletteDefaults(activePreset, mode) : undefined;
  const customized = !!defaults && (accent !== defaults.accent || accent2 !== defaults.accent2);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<'accent' | 'accent2'>('accent');

  const setColor = (hex: string) => void update(editing === 'accent' ? { accent: hex } : { accent2: hex });

  const resetColors = () => {
    if (!defaults) return;
    void update({ accent: defaults.accent, accent2: defaults.accent2 });
  };

  return (
    <div className={`theme-picker${showLabel ? ' mt-(--q-inline)' : ''}`}>
      <div className="theme-picker-heading">
        {showLabel && <span className="text-sm font-medium">{tr('settings.theme')}</span>}
        <button
          type="button"
          role="switch"
          aria-label={tr('settings.themeDark')}
          aria-checked={mode === 'dark'}
          title={`${tr('settings.themeLight')} / ${tr('settings.themeDark')}`}
          className="theme-mode-toggle"
          onClick={() => update(themeModePatch(settings, mode === 'dark' ? 'light' : 'dark', prefersDark))}
        >
          <span className="theme-mode-thumb" aria-hidden="true" />
          <SunIcon className="h-4 w-4" aria-hidden="true" />
          <MoonIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-(--q-group) space-y-(--q-group)">
        {/* Setup shows every palette in one row; Settings keeps the seasonal group apart. */}
        {(large
          ? [{ key: 'themes', title: 'Themes', entries: [...THEMES, ...SEASONAL] }]
          : [{ key: 'themes', title: 'Themes', entries: THEMES }, { key: 'seasonal', title: 'Seasonal', entries: SEASONAL }]
        ).map((section) => (
          <div key={section.key}>
            {!large && <span className="quiet-group-label">{section.title}</span>}
            <div className={`theme-swatch-list${large ? ' theme-swatch-row' : ''}`} role="radiogroup" aria-label={section.title}>
              {section.entries.map((entry) => {
                const palette = themePaletteDefaults(findThemePreset(entry.id)!, mode);
                const active = activeId === palette.id;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    onClick={() => update(themePalettePatch(settings, entry.id, prefersDark))}
                    onKeyDown={(event) => {
                      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
                      if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                      event.preventDefault();
                      const buttons = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(event.currentTarget) + direction + buttons.length) % buttons.length;
                      buttons[next].focus();
                      buttons[next].click();
                    }}
                    title={entry.label}
                    role="radio"
                    aria-checked={active}
                    tabIndex={active || (entry === section.entries[0] && !section.entries.some((item) => themePaletteDefaults(findThemePreset(item.id)!, mode).id === activeId)) ? 0 : -1}
                    className={`theme-swatch-button${large ? ' theme-swatch-large' : ''}`}
                  >
                    <span className="theme-swatch" style={{ color: palette.accent }}>
                      <ThemeIcon name={THEME_ICON[entry.id]} />
                    </span>
                    <span className="text-2xs font-medium">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Custom colors: the wheel rides on top of the selected preset. */}
      <div className="theme-custom-colors mt-(--q-group)">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          type="button"
          className="theme-custom-trigger quiet-row gap-3 py-(--q-inline)"
        >
          <span
            className="h-8 w-8 shrink-0 rounded-full border border-line"
            style={{ background: WHEEL_SWATCH }}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{tr('settings.customColors')}</span>
            <span className="mt-(--q-tight) block text-xs text-ink-faint">
              {customized ? tr('settings.customColorsOn') : tr('settings.customColorsHint')}
            </span>
          </span>
          <span
            aria-hidden
            className="h-5 w-10 shrink-0 rounded-full border border-line"
            style={{ background: `linear-gradient(135deg, ${accent}, ${accent2})` }}
          />
          <ChevronDownIcon aria-hidden className={`h-4 w-4 shrink-0 text-ink-soft transition-transform duration-(--dur-med) ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="flex flex-wrap items-start gap-4 py-(--q-inline)">
            <ColorWheel
              value={editing === 'accent' ? accent : accent2}
              onChange={setColor}
              label={editing === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
            />
            <div className="min-w-[150px] flex-1 space-y-(--q-inline)">
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={tr('settings.customColors')}>
                {(['accent', 'accent2'] as const).map((which) => {
                  const on = editing === which;
                  return (
                    <button
                      key={which}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setEditing(which)}
                      className="quiet-tab items-center"
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
                  className="quiet-field py-1.5 font-mono text-xs"
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
                className="theme-custom-reset text-2xs text-accent hover:underline disabled:text-ink-faint disabled:no-underline"
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
