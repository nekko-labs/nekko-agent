import React from 'react';
import type { AppSettings, WallLayout } from '@nekko-agent/shared';
import { loadWallState, saveWallState, toWallSetting } from '../commandWall.js';

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
  return <div className="mt-3 border-t border-line pt-3">
    <label className="flex items-center justify-between gap-3 text-[13px]" htmlFor="wall-layout-setting">Wall layout
      <select id="wall-layout-setting" className="input max-w-[180px] py-1.5" value={layout.mode} onChange={(e) => change({ mode: e.target.value as WallLayout['mode'] })}>
        <option value="focus">Focused</option>
        <option value="grid">Dynamic</option>
        <option value="fixed">Grid</option>
      </select>
    </label>
    <p className="mt-1 text-[12px] text-ink-faint">Grid uses even rows and columns. Ctrl/Cmd+Shift+1, 2 or 3 selects Focused, Dynamic or Grid.</p>
    <div className="mt-3 flex flex-wrap items-center gap-4">
      {(['rows', 'cols'] as const).map((key) => <label key={key} className="flex items-center gap-2 text-[13px]" htmlFor={`wall-grid-${key}`}>
        {key === 'rows' ? 'Grid rows' : 'Grid columns'}
        <select id={`wall-grid-${key}`} className="input w-16 py-1.5" value={layout[key]} onChange={(e) => change({ [key]: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>)}
    </div>
  </div>;
}
