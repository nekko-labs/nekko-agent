import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { Toggle } from './SettingsView.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

export function DesktopBehaviorSection({ settings, update }: Props) {
  return <section id="desktop-behavior" className="card mt-5 p-5" aria-labelledby="desktop-behavior-heading">
    <h2 id="desktop-behavior-heading" className="font-semibold">Desktop behavior</h2>
    <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
      <div><label htmlFor="desktop-close-behavior" className="text-sm">When I close the window</label>
        <p className="text-2xs text-ink-faint">Keep agents working in the system tray, or shut down Nekko and its managed processes. Sleep and shutdown can interrupt background work.</p></div>
      <select id="desktop-close-behavior" className="input max-w-[200px] py-1" value={settings.desktopCloseBehavior ?? 'tray'} onChange={e => update({ desktopCloseBehavior: e.target.value === 'shutdown' ? 'shutdown' : 'tray' })}>
        <option value="tray">Keep running in tray</option><option value="shutdown">Shut down Nekko</option>
      </select>
    </div>
    <LowMemoryRows settings={settings} update={update} />
  </section>;
}

/** The tray's low-memory prompt: the remembered choice, and the apps always closed. */
function LowMemoryRows({ settings, update }: Props) {
  const apps = settings.lowMemoryCloseApps ?? [];
  return <>
    <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
      <div><label htmlFor="desktop-low-memory" className="text-sm">When memory runs low</label>
        <p className="text-2xs text-ink-faint">Nekko asks above the tray whether to close the app holding the most memory, shut down Nekko's local models (agents using them stop), or ignore it. A remembered choice is used without asking.</p></div>
      <select id="desktop-low-memory" className="input max-w-[200px] py-1" value={settings.lowMemoryAction ?? 'ask'} onChange={e => update({ lowMemoryAction: e.target.value === 'release' || e.target.value === 'ignore' ? e.target.value : undefined })}>
        <option value="ask">Ask me</option><option value="release">Shut down local models</option><option value="ignore">Do nothing</option>
      </select>
    </div>
    {apps.length > 0 && <div className="mt-2" aria-labelledby="desktop-low-memory-apps">
      <span id="desktop-low-memory-apps" className="text-sm">Always ask these apps to close</span>
      <p className="text-2xs text-ink-faint">When one of them holds the most memory, Nekko asks it to close the way its close button would, so it can still ask to save.</p>
      <ul className="mt-1 flex flex-wrap gap-2">
        {apps.map(app => <li key={app} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs">{app}
          <button type="button" className="text-ink-faint hover:text-ink" aria-label={`Stop closing ${app}`} onClick={() => update({ lowMemoryCloseApps: apps.filter(a => a !== app) })}>×</button></li>)}
      </ul>
    </div>}
  </>;
}

export function FunSection({ settings, update }: Props) {
  const tr = useT();
  return <section id="fun" className="card mt-5 p-5" aria-labelledby="fun-heading">
    <h2 id="fun-heading" className="font-semibold">Fun</h2>
    <p className="mt-1 text-2xs text-ink-faint">A little more Nekko. All optional.</p>
    <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3"><span className="text-sm">{tr('settings.mascot')}</span>
      <Toggle aria-label="Show Nekko mascot" on={settings.mascotEnabled} onChange={v => update({ mascotEnabled: v })} /></div>
    <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3"><div><span className="text-sm">Tray farewell</span>
      <p className="text-2xs text-ink-faint">Nekko blinks and says goodbye above the tray for two seconds when the desktop window hides. The first-close explanation is always shown.</p></div>
      <Toggle aria-label="Tray farewell" on={settings.trayFarewellEnabled !== false} onChange={v => update({ trayFarewellEnabled: v })} /></div>
  </section>;
}
