import React from 'react';
import type { AppSettings, WallLayout } from '@nekko-agent/shared';
import { loadWallState, saveWallState, toWallSetting } from '../commandWall.js';
import { SettingRow } from '../components/SettingsSection.js';

/** Patch only layout preferences, keeping every window and other wall setting. */
export function wallLayoutPatch(settings: AppSettings, patch: Partial<WallLayout>, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const wall = loadWallState(storage, settings.commandWall);
  const next = { ...wall, layout: { ...wall.layout, ...patch } };
  saveWallState(storage, next);
  return { commandWall: toWallSetting(next) };
}

export function WallLayoutSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => unknown }) {
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
  const { layout } = loadWallState(storage, settings.commandWall);
  const change = (patch: Partial<WallLayout>) => update(wallLayoutPatch(settings, patch, storage));
  return <div className="mt-(--q-inline)">
    <SettingRow title="Wall layout" htmlFor="wall-layout-setting" detail="Ctrl/Cmd+Shift+1 or 2 selects Focused or Dynamic."
      control={<select id="wall-layout-setting" className="quiet-field max-w-[180px] py-1.5" value={layout.mode} onChange={(e) => change({ mode: e.target.value as WallLayout['mode'] })}>
        <option value="focus">Focused</option>
        <option value="grid">Dynamic</option>
      </select>} />
    <SettingRow title="Fixed grid" htmlFor="wall-fixed-grid" detail="Dynamic lays windows out in even rows and columns instead of free-form splits."
      control={<input id="wall-fixed-grid" type="checkbox" checked={!!layout.fixedGrid} onChange={(e) => change({ fixedGrid: e.target.checked })} />} />
    <div className="mt-(--q-inline) flex flex-wrap items-center gap-4" aria-disabled={!layout.fixedGrid}>
      {(['rows', 'cols'] as const).map((key) => <label key={key} className={`flex items-center gap-2 text-sm font-medium ${layout.fixedGrid ? '' : 'text-ink-faint'}`} htmlFor={`wall-grid-${key}`}>
        {key === 'rows' ? 'Grid rows' : 'Grid columns'}
        <select id={`wall-grid-${key}`} className="quiet-field w-16 py-1.5" disabled={!layout.fixedGrid} value={layout[key]} onChange={(e) => change({ [key]: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>)}
    </div>
  </div>;
}
