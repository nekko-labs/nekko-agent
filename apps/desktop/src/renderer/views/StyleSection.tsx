import React, { useEffect } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore, textScaleOf } from '../store.js';
import { ExternalIcon, FolderIcon } from '../icons.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

const SCALES = [80, 90, 100, 110, 125, 150];
const FONTS_DOCS = 'https://nekkoagent.com/docs/fonts-and-text';

/**
 * Settings > Style: text size and the two font families. The defaults are the
 * website's fonts (Inter Tight, JetBrains Mono); a font file dropped in the
 * fonts folder shows up in both lists after Reload. An empty string saves
 * "default", since a patch cannot carry `undefined`.
 */
export function StyleSection({ settings, update }: Props) {
  const customFonts = useStore((s) => s.customFonts);
  const loadCustomFonts = useStore((s) => s.loadCustomFonts);
  useEffect(() => { void loadCustomFonts(); }, [loadCustomFonts]);
  const families = customFonts?.families ?? [];

  const fontSelect = (id: string, value: string | undefined, onChange: (v: string) => void, def: string, system: string) => (
    <select id={id} className="input max-w-[220px] py-1" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{def} (default)</option>
      <option value={system}>System</option>
      {families.length > 0 && <optgroup label="Your fonts">{families.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>}
      {/* A saved font whose file is gone still shows, so the select is not blank. */}
      {value && value !== system && !families.includes(value) && <option value={value}>{value} (missing)</option>}
    </select>
  );

  return <section id="style" className="card mt-6 p-5" aria-labelledby="style-heading">
    <h2 id="style-heading" className="font-semibold">Fonts and text</h2>
    <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
      <div className="min-w-0"><label htmlFor="style-text-size" className="text-sm">Text size</label>
        <p className="text-2xs text-ink-faint">Scales all text and controls in the app.</p></div>
      <select id="style-text-size" className="input max-w-[220px] py-1" value={textScaleOf(settings.textScale)} onChange={(e) => update({ textScale: Number(e.target.value) })}>
        {SCALES.map((s) => <option key={s} value={s}>{s}%{s === 100 ? ' (default)' : ''}</option>)}
      </select>
    </div>
    <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
      <div className="min-w-0"><label htmlFor="style-font-sans" className="text-sm">Interface font</label>
        <p className="text-2xs text-ink-faint" style={{ fontFamily: 'var(--font-sans)' }}>The quick brown fox jumps over the lazy cat.</p></div>
      {fontSelect('style-font-sans', settings.fontSans, (v) => update({ fontSans: v }), 'Inter Tight', 'system-ui')}
    </div>
    <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
      <div className="min-w-0"><label htmlFor="style-font-mono" className="text-sm">Code font</label>
        <p className="text-2xs text-ink-faint" style={{ fontFamily: 'var(--font-mono)' }}>{'const nekko = () => "meow"; // 0O 1lI'}</p></div>
      {fontSelect('style-font-mono', settings.fontMono, (v) => update({ fontMono: v }), 'JetBrains Mono', 'ui-monospace')}
    </div>
    <div className="mt-3 border-t border-line pt-3">
      <span className="text-sm">Add your own fonts</span>
      <p className="text-2xs text-ink-faint">Drop .ttf, .otf, .woff or .woff2 files into your fonts folder, then press Reload. Each file appears in the lists above under its file name.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1 text-xs" disabled={!customFonts} onClick={() => customFonts && void window.nekko.openPath(customFonts.dir)}>
          <FolderIcon className="h-3.5 w-3.5" />Open fonts folder
        </button>
        <button className="btn btn-outline py-1 text-xs" onClick={() => void loadCustomFonts()}>Reload fonts</button>
        <a className="text-xs text-accent" href={FONTS_DOCS} onClick={(e) => { e.preventDefault(); void window.nekko.openPath(FONTS_DOCS); }}>How to add fonts <ExternalIcon className="inline h-2.5 w-2.5" /></a>
        {customFonts && <code className="min-w-0 truncate text-2xs text-ink-faint" title={customFonts.dir}>{customFonts.dir}</code>}
      </div>
    </div>
  </section>;
}
