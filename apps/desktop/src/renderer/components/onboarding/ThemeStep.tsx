import React from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store.js';
import { ThemePresetPicker } from '../ThemePresetPicker.js';

/**
 * Pick a theme preset. A click writes the settings and calls `applyTheme`
 * immediately, so the wizard itself live-previews the choice - and the choice
 * stays applied even if the user then skips forward through the rest.
 */
export function ThemeStep() {
  const { settings, applyTheme } = useStore(useShallow((s) => ({ settings: s.settings, applyTheme: s.applyTheme })));

  const update = async (patch: Partial<AppSettings>) => {
    const next = await window.nekko.updateSettings(patch);
    useStore.setState({ settings: next });
    applyTheme();
  };

  if (!settings) return null;

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Make it yours</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-ink-soft">
        Pick a look. It applies right away, and you can change it any time in Settings → Appearance.
      </p>
      <div className="mt-6">
        <ThemePresetPicker settings={settings} update={update} showLabel={false} large />
      </div>
    </div>
  );
}
