import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';

vi.mock('./store.js', () => ({ useStore: { getState: () => ({}), setState: () => {} }, textScaleOf: (v?: number) => v ?? 100 }));
const { matchSettings, matchSettingsPages, SETTINGS_INDEX } = await import('./settingsIndex.js');

const ids = (q: string) => matchSettings(q).map((e) => e.id);

describe('command palette settings search', () => {
  it('matches partial words in labels and keywords, every word required', () => {
    expect(ids('notif')).toContain('desktop-notifications');
    expect(ids('crash')).toEqual(['telemetry']);
    expect(ids('help impr')).toEqual(['telemetry']);
    expect(ids('git base')).toEqual(['git-baseline']);
    expect(ids('')).toEqual([]);
  });

  it('finds the Settings group that holds an unindexed section', () => {
    expect(matchSettingsPages('guardrail').map((p) => p.group)).toEqual(['safety']);
    expect(matchSettingsPages('simple').map((p) => p.group)).toEqual(['customize']);
  });

  it.each(['customize', 'appearance', 'theme', 'style', 'font size', 'accessibility', 'simple mode', 'agents wall'])('routes %s to Customize', (query) => {
    expect(matchSettingsPages(query).map((page) => page.group)).toEqual(['customize']);
  });

  it('routes moved controls to Customize without moving operational settings', () => {
    const moved = ['sidebar-skills', 'sidebar-connectors', 'background-animation', 'language', 'chat-pane-action', 'auto-complete', 'tips', 'warn-before-yolo', 'confirm-deletions', 'close-behavior', 'low-memory', 'agent-activity-animation', 'mascot', 'tray-farewell', 'text-size'];
    for (const id of moved) expect(SETTINGS_INDEX.find((entry) => entry.id === id)?.group).toBe('customize');
    expect(SETTINGS_INDEX.filter((entry) => entry.group === 'general').map((entry) => entry.id)).toEqual(['desktop-notifications']);
    expect(SETTINGS_INDEX.find(entry => entry.id === 'telemetry')?.group).toBe('support');
    expect(matchSettingsPages('github star').map(page => page.group)).toEqual(['support']);
    expect(matchSettingsPages('notifications').map((page) => page.group)).toEqual(['general']);
    expect(matchSettingsPages('remote access').map((page) => page.group)).toEqual(['phone']);
  });

  it('keeps sibling keys when a nested switch flips, and inverts Confirm deletions', () => {
    const s = { experimental: { memory: true }, skipDeleteConfirmation: true } as unknown as AppSettings;
    const design = SETTINGS_INDEX.find((e) => e.id === 'experimental-design')!.control;
    if (design.kind !== 'toggle') throw new Error('toggle expected');
    expect(design.set(true, s)).toEqual({ experimental: { memory: true, design: true } });
    const confirm = SETTINGS_INDEX.find((e) => e.id === 'confirm-deletions')!.control;
    if (confirm.kind !== 'toggle') throw new Error('toggle expected');
    expect(confirm.get(s)).toBe(false);
    expect(confirm.set(true, s)).toEqual({ skipDeleteConfirmation: false });
  });

  it('finds and restores the model-switch notice without changing other developer settings', () => {
    expect(ids('tokens')).toContain('model-switch-notice');
    expect(ids('effort')).toContain('model-switch-notice');
    const control = SETTINGS_INDEX.find(e => e.id === 'model-switch-notice')!.control;
    if (control.kind !== 'toggle') throw new Error('toggle expected');
    expect(control.get({} as AppSettings)).toBe(true);
    const settings = { developer: { serverControls: true, showContextChangeNotice: false } } as AppSettings;
    expect(control.get(settings)).toBe(false);
    expect(control.set(true, settings)).toEqual({ developer: { serverControls: true, showContextChangeNotice: true } });
  });

  it('gives every select a current value that is one of its options', () => {
    for (const e of SETTINGS_INDEX) {
      if (e.control.kind === 'select') expect(e.control.options.map((o) => o.value)).toContain(e.control.get({} as AppSettings));
    }
  });
});
