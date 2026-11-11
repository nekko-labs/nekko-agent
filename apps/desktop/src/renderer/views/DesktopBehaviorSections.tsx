import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useT } from '../i18n.js';
import { Toggle } from './SettingsView.js';
import { SettingRow, SettingsSection } from '../components/SettingsSection.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

export function DesktopBehaviorSection({ settings, update }: Props) {
  return <SettingsSection id="desktop-behavior" title="Desktop behavior">
    <SettingRow className="mt-(--q-inline)" title="When I close the window" htmlFor="desktop-close-behavior"
      detail="Keep agents working in the system tray, or shut down Nekko and its managed processes. Sleep and shutdown can interrupt background work."
      control={<select id="desktop-close-behavior" className="quiet-field max-w-[200px] py-1.5" value={settings.desktopCloseBehavior ?? 'tray'} onChange={e => update({ desktopCloseBehavior: e.target.value === 'shutdown' ? 'shutdown' : 'tray' })}>
        <option value="tray">Keep running in tray</option><option value="shutdown">Shut down Nekko</option>
      </select>} />
    <LowMemoryRows settings={settings} update={update} />
  </SettingsSection>;
}

/** The tray's low-memory prompt: the remembered choice, and the apps always closed. */
function LowMemoryRows({ settings, update }: Props) {
  const apps = settings.lowMemoryCloseApps ?? [];
  return <>
    <SettingRow title="When memory runs low" htmlFor="desktop-low-memory"
      detail="Nekko asks above the tray whether to close the app holding the most memory, shut down Nekko's local models (agents using them stop), or ignore it. A remembered choice is used without asking."
      control={<select id="desktop-low-memory" className="quiet-field max-w-[200px] py-1.5" value={settings.lowMemoryAction ?? 'ask'} onChange={e => update({ lowMemoryAction: e.target.value === 'release' || e.target.value === 'ignore' ? e.target.value : undefined })}>
        <option value="ask">Ask me</option><option value="release">Shut down local models</option><option value="ignore">Do nothing</option>
      </select>} />
    {apps.length > 0 && <div className="mt-(--q-group)" aria-labelledby="desktop-low-memory-apps">
      <div id="desktop-low-memory-apps" className="quiet-group-label">Always ask these apps to close</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">When one of them holds the most memory, Nekko asks it to close the way its close button would, so it can still ask to save.</p>
      <ul className="-mx-2 mt-(--q-inline)">
        {apps.map(app => <li key={app} className="quiet-row min-h-(--q-row) gap-2 px-2!" data-quiet-row>
          <span className="min-w-0 flex-1 truncate text-sm">{app}</span>
          <button type="button" className="btn btn-ghost quiet-row-action py-1 text-xs" aria-label={`Stop closing ${app}`} onClick={() => update({ lowMemoryCloseApps: apps.filter(a => a !== app) })}>Stop closing</button></li>)}
      </ul>
    </div>}
  </>;
}

export function AnimationsSection({ settings, update }: Props) {
  return <SettingsSection id="animations" title="Animations">
    <SettingRow className="mt-(--q-inline)" title="Agent activity animation"
      detail="Nekko moves beside Agent panel groups while agents work. Off holds Nekko still. This setting decides, whatever your system's reduce motion preference says."
      control={<Toggle aria-label="Agent activity animation" on={settings.agentActivityAnimation !== false} onChange={v => update({ agentActivityAnimation: v })} />} />
  </SettingsSection>;
}

export function FunSection({ settings, update }: Props) {
  const tr = useT();
  return <SettingsSection id="fun" title="Fun" help="A little more Nekko. All optional.">
    <SettingRow className="mt-(--q-inline)" title={tr('settings.mascot')}
      control={<Toggle aria-label="Show Nekko mascot" on={settings.mascotEnabled} onChange={v => update({ mascotEnabled: v })} />} />
    <SettingRow title="Tray farewell"
      detail="Nekko blinks and says goodbye above the tray for two seconds when the desktop window hides. The first-close explanation is always shown."
      control={<Toggle aria-label="Tray farewell" on={settings.trayFarewellEnabled !== false} onChange={v => update({ trayFarewellEnabled: v })} />} />
  </SettingsSection>;
}
