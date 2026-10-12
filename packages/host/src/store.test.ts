import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDataDir } from './paths.js';
import type { AppSettings } from '@nekko-agent/shared';
import { getSettings, resetSettings, saveSettings, settingsChanged, settingsSaved, useSettingsDaemon } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('getSettings', () => {
  it('loads a settings file from before the tool-step limit was removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-store-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', maxSteps: 250 }));
    const settings = withDataDir(dir, () => getSettings());
    expect(settings.theme).toBe('dark');
    expect('maxSteps' in settings).toBe(false);
  });
});

describe('settings under the engine daemon', () => {
  afterEach(() => useSettingsDaemon(null));

  it('sends every write to the daemon in order and never writes the file itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-store-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const before = readFileSync(join(dir, 'settings.json'), 'utf8');
    const sent: Array<[string, unknown[]]> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The daemon's copy: what it answers once our writes reach it, plus a change from the UI.
    let daemon = withDataDir(dir, () => getSettings());
    useSettingsDaemon(async (channel, args) => {
      sent.push([channel, args]);
      await gate;
      daemon = channel === 'settings:save' ? { ...daemon, ...(args[0] as object) } : ({ theme: 'system' } as AppSettings);
      return daemon;
    });
    await withDataDir(dir, async () => {
      expect(saveSettings({ theme: 'light' }).theme).toBe('light');
      saveSettings({ accent: '#000000' });
      // A UI change lands at the daemon while ours are in flight: our copy keeps both.
      settingsChanged({ ...daemon, mascotEnabled: false }, { mascotEnabled: false });
      expect(getSettings()).toMatchObject({ theme: 'light', accent: '#000000', mascotEnabled: false });
      release();
      await settingsSaved();
      expect(sent).toEqual([['settings:save', [{ theme: 'light' }]], ['settings:save', [{ accent: '#000000' }]]]);
      expect(getSettings()).toMatchObject({ theme: 'light', accent: '#000000' });
      resetSettings();
      await settingsSaved();
      expect(sent.at(-1)).toEqual(['settings:resetHost', []]);
      // Nothing of ours in flight: the daemon's word is taken whole.
      settingsChanged({ theme: 'dark' } as AppSettings, { theme: 'dark' });
      expect(getSettings()).toEqual({ theme: 'dark' });
    });
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before);
  });

  it('writes the file itself without a daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-store-'));
    dirs.push(dir);
    withDataDir(dir, () => saveSettings({ theme: 'light' }));
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
  });
});
