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

  it('gives every select a current value that is one of its options', () => {
    for (const e of SETTINGS_INDEX) {
      if (e.control.kind === 'select') expect(e.control.options.map((o) => o.value)).toContain(e.control.get({} as AppSettings));
    }
  });
});
