import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { Toggle } from './SettingsView.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

export function DesktopBehaviorSection({ settings, update }: Props) {
  return <section id="desktop-behavior" className="card mt-5 p-5" aria-labelledby="desktop-behavior-heading">
    <h2 id="desktop-behavior-heading" className="font-semibold">Desktop behavior</h2>
    <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
      <div><label htmlFor="desktop-close-behavior" className="text-[13px]">When I close the window</label>
        <p className="text-[11px] text-ink-faint">Keep agents working in the system tray, or shut down Nekko and its managed processes. Sleep and shutdown can interrupt background work.</p></div>
      <select id="desktop-close-behavior" className="input max-w-[200px] py-1.5" value={settings.desktopCloseBehavior ?? 'tray'} onChange={e => update({ desktopCloseBehavior: e.target.value === 'shutdown' ? 'shutdown' : 'tray' })}>
        <option value="tray">Keep running in tray</option><option value="shutdown">Shut down Nekko</option>
      </select>
    </div>
  </section>;
}

export function FunSection({ settings, update }: Props) {
  const tr = useT();
  return <section id="fun" className="card mt-5 p-5" aria-labelledby="fun-heading">
    <h2 id="fun-heading" className="font-semibold">Fun</h2>
    <p className="mt-1 text-[11px] text-ink-faint">A little more Nekko. All optional.</p>
    <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3"><span className="text-[13px]">{tr('settings.mascot')}</span>
      <Toggle aria-label="Show Nekko mascot" on={settings.mascotEnabled} onChange={v => update({ mascotEnabled: v })} /></div>
    <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3"><div><span className="text-[13px]">Tray farewell</span>
      <p className="text-[11px] text-ink-faint">Nekko blinks and says goodbye above the tray for two seconds when the desktop window hides. The first-close explanation is always shown.</p></div>
      <Toggle aria-label="Tray farewell" on={settings.trayFarewellEnabled !== false} onChange={v => update({ trayFarewellEnabled: v })} /></div>
  </section>;
}
