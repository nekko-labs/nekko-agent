import React, { useEffect } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore, textScaleOf } from '../store.js';
import { TEXT_SCALES } from '../textScale.js';
import { ExternalIcon, FolderIcon } from '../icons.js';
import { SettingRow, SettingsSection } from '../components/SettingsSection.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

const FONTS_DOCS = 'https://nekkoagent.com/docs/fonts-and-text';

/**
 * Settings > Style: text size, the two font families and a preview of both at
 * the current size. The defaults are the
 * design system's fonts (Geist, Geist Mono); a font file dropped in the
 * fonts folder shows up in both lists after Reload. An empty string saves
 * "default", since a patch cannot carry `undefined`.
 */
export function StyleSection({ settings, update }: Props) {
  const customFonts = useStore((s) => s.customFonts);
  const loadCustomFonts = useStore((s) => s.loadCustomFonts);
  useEffect(() => { void loadCustomFonts(); }, [loadCustomFonts]);
  const families = customFonts?.families ?? [];

  const fontSelect = (id: string, value: string | undefined, onChange: (v: string) => void, def: string, system: string) => (
    <select id={id} className="quiet-field max-w-[220px] py-1.5" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{def} (default)</option>
      <option value={system}>System</option>
      {families.length > 0 && <optgroup label="Your fonts">{families.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>}
      {/* A saved font whose file is gone still shows, so the select is not blank. */}
      {value && value !== system && !families.includes(value) && <option value={value}>{value} (missing)</option>}
    </select>
  );

  return <SettingsSection id="style" title="Fonts and text">
    <SettingRow className="mt-(--q-inline)" title="Text size" htmlFor="style-text-size" detail="Scales all text and controls in the app."
      control={<select id="style-text-size" className="quiet-field max-w-[220px] py-1.5" value={textScaleOf(settings.textScale)} onChange={(e) => update({ textScale: Number(e.target.value) })}>
        {TEXT_SCALES.map((s) => <option key={s} value={s}>{s}%{s === 100 ? ' (default)' : ''}</option>)}
      </select>} />
    <SettingRow title="Interface font" htmlFor="style-font-sans"
      detail={<span style={{ fontFamily: 'var(--font-sans)' }}>The quick brown fox jumps over the lazy cat.</span>}
      control={fontSelect('style-font-sans', settings.fontSans, (v) => update({ fontSans: v }), 'Geist', 'system-ui')} />
    <SettingRow title="Code font" htmlFor="style-font-mono"
      detail={<span style={{ fontFamily: 'var(--font-mono)' }}>{'const nekko = () => "meow"; // 0O 1lI'}</span>}
      control={fontSelect('style-font-mono', settings.fontMono, (v) => update({ fontMono: v }), 'Geist Mono', 'ui-monospace')} />
    {/* The page is already at the chosen size, so the preview needs no zoom of its own. */}
    <div className="mt-(--q-group) overflow-hidden" role="group" aria-label="Text preview" data-text-size-preview>
      <p className="quiet-group-label">Preview at {textScaleOf(settings.textScale)}%</p>
      <p className="mt-(--q-inline) font-semibold">Fix the failing test</p>
      <p className="text-sm">Nekko found the problem and is writing the fix now.</p>
      <p className="mt-(--q-tight) text-xs text-ink-soft">Two files changed, a few seconds ago</p>
      <code className="mt-(--q-tight) block text-xs">{'const nekko = () => "meow";'}</code>
    </div>
    <div className="mt-(--q-group)">
      <div className="text-sm font-medium">Add your own fonts</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">Drop .ttf, .otf, .woff or .woff2 files into your fonts folder, then press Reload. Each file appears in the lists above under its file name.</p>
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost py-1 text-xs" disabled={!customFonts} onClick={() => customFonts && void window.nekko.openPath(customFonts.dir)}>
          <FolderIcon className="h-3.5 w-3.5" />Open fonts folder
        </button>
        <button className="btn btn-ghost py-1 text-xs" onClick={() => void loadCustomFonts()}>Reload fonts</button>
        <a className="text-xs text-accent" href={FONTS_DOCS} onClick={(e) => { e.preventDefault(); void window.nekko.openPath(FONTS_DOCS); }}>How to add fonts <ExternalIcon className="inline h-2.5 w-2.5" /></a>
        {customFonts && <code className="min-w-0 truncate text-2xs text-ink-faint" title={customFonts.dir}>{customFonts.dir}</code>}
      </div>
    </div>
  </SettingsSection>;
}
